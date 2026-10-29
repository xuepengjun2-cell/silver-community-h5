// Durable H5 upload-task lifecycle. Source objects are never deleted here.
// SQL status is authoritative; in-memory progress is intentionally best-effort.
function taskError(message, status = 409, code = 'VIDEO_TASK_STATE') {
  return Object.assign(new Error(message), { httpStatus: status, code });
}

function createProjectVideoTasks(options) {
  const locks = new Map();
  const controls = new Map();
  let dispatching = null;
  let recovering = null;
  let scanCursor = 0;
  const labels = { queued:'等待后台处理', preparing:'检查已上传文件', downloading:'准备原片', probing:'检查视频格式', converting:'后台转换', verifying:'校验完整时长和画面', poster:'生成视频封面', uploading:'保存成片与封面', publishing:'保存相册结果', paused:'已停止，可继续', completed:'处理完成' };
  const terminal = new Set(['completed','aborted','dismissed']);
  const log = error => { try { options.log?.(error); } catch {} };

  async function locked(id, fn) {
    const previous = locks.get(id) || Promise.resolve();
    const work = previous.catch(() => {}).then(fn);
    locks.set(id, work);
    try { return await work; } finally { if (locks.get(id) === work) locks.delete(id); }
  }
  function progress(id, event) {
    const control = controls.get(id);
    if (control?.signal?.aborted) return;
    const stage = event.phase || event.stage || 'preparing';
    const percent = Number.isFinite(event.percent) ? Math.max(0, Math.min(99, event.percent)) : null;
    const entry = control || {};
    entry.progress = { stage, label: labels[stage] || '后台处理中', percent };
    controls.set(id, entry);
  }
  function getProgress(row) {
    if (row.status === 'paused') return {stage:'paused',label:labels.paused,percent:null};
    if (row.status === 'queued') return {stage:'queued',label:labels.queued,percent:null};
    if (row.status === 'completed') return {stage:'completed',label:labels.completed,percent:100};
    if (['failed','delivery_failed','aborted','dismissed'].includes(row.status)) return null;
    return controls.get(row.id)?.progress || null;
  }
  async function authorize(row, actor, control = false) {
    if (!row) throw taskError('上传任务不存在', 404);
    const allowed = control && options.canControl
      ? await options.canControl(row, actor)
      : await options.canManage(row, actor);
    if (!allowed) throw taskError('相册或上传权限已变更，任务已保留',403,'VIDEO_TASK_FORBIDDEN');
  }
  function assertSourceUnchanged(latest, row) {
    if (latest.status!==row.status || latest.object_key!==row.object_key ||
        latest.upload_id!==row.upload_id || latest.owner_id!==row.owner_id ||
        latest.project_id!==row.project_id || Number(latest.file_size)!==Number(row.file_size) ||
        Number(latest.part_size)!==Number(row.part_size) || Number(latest.part_count)!==Number(row.part_count)) {
      throw taskError('任务状态已变化，原片保留，不会自动重新入队');
    }
  }
  async function parts(row) {
    const expected = Number(row.part_count), partSize = Number(row.part_size), fileSize = Number(row.file_size);
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > 10000 ||
        !Number.isSafeInteger(partSize) || partSize < 1 || !Number.isSafeInteger(fileSize) || fileSize < 1 ||
        expected !== Math.ceil(fileSize / partSize)) {
      throw taskError('原片分片记录不完整，任务已保留待核查',409,'VIDEO_UPLOAD_METADATA');
    }
    const {client,bucket} = options.getStorage();
    const listed = await client.listParts({bucket,key:row.object_key,uploadId:row.upload_id,maxParts:10000});
    const list = listed?.data?.Parts || listed?.Parts || [];
    const numbered = new Map(list.map(p => [Number(p.PartNumber),p]));
    const valid = list.length === expected && numbered.size === expected && Array.from({length:expected},(_,i)=>i+1).every(n=>{
      const p=numbered.get(n);
      const size=n<expected?partSize:fileSize-(expected-1)*partSize;
      return p && typeof p.ETag==='string' && p.ETag.trim() && Number(p.Size)===size;
    });
    return {valid,completedParts:list.map(p=>Number(p.PartNumber)).filter(p=>Number.isInteger(p)&&p>=1&&p<=expected).sort((a,b)=>a-b),uploadedBytes:list.reduce((n,p)=>n+(Number.isSafeInteger(Number(p.Size))&&Number(p.Size)>0?Number(p.Size):0),0)};
  }
  async function prepare(id, {actor, resume=false, auto=false} = {}) {
    const result = await locked(id, async () => {
      let row = await options.read(id);
      await authorize(row, actor);
      if (row.status==='completed') return row;
      if (['aborted','dismissed'].includes(row.status)) throw taskError('此任务已移出，不会重新处理');
      if (['queued','processing'].includes(row.status)) return row;
      if (row.status==='paused' && !resume) throw taskError('任务已停止，请点击继续');
      if (row.status==='delivery_failed' && !resume) return row;
      if (!['uploading','failed','delivery_failed','paused'].includes(row.status)) throw taskError('任务状态暂不支持继续，请先核查');
      if (!options.enabled()) throw taskError('后台处理已暂停，原片保留',503,'VIDEO_PROCESSING_PAUSED');
      options.preparing?.add(id);
      progress(id,{phase:'preparing',percent:null});
      try {
        const {client,bucket}=options.getStorage();
        let head=null;
        try { head=await client.headObject({bucket,key:row.object_key}); } catch (error) {
          if (error.statusCode && Number(error.statusCode)!==404) throw error;
        }
        if (head) options.assertSize(head,row.file_size);
        else {
          const uploaded=await parts(row);
          if (!uploaded.valid) {
            // Listing parts may wait on storage. Recheck the requester and SQL
            // row before returning a resumable upload or changing its state.
            const latest=await options.read(id);
            await authorize(latest,actor);
            if (latest.status==='completed') return latest;
            assertSourceUnchanged(latest,row);
            if (resume && ['paused','failed'].includes(row.status)) {
              await options.update(id,{status:'uploading',error:null});
              row={...latest,status:'uploading',error:null};
            }
            if (auto || resume) return {...row,...uploaded};
            throw taskError('原片仍在上传，后台会在分片完整后自动继续',409,'VIDEO_UPLOAD_INCOMPLETE');
          }
          await client.completeMultipartUpload({bucket,key:row.object_key,uploadId:row.upload_id,completeAll:true});
          options.assertSize(await client.headObject({bucket,key:row.object_key}),row.file_size);
        }
        // Permissions may change while TOS merges the source.
        const latest=await options.read(id);
        await authorize(latest,actor);
        if (latest.status==='completed') return latest;
        // The shared lock covers our handlers, but a concurrent recovery/admin
        // operation may change the SQL row while TOS is finishing a merge.
        assertSourceUnchanged(latest,row);
        await options.update(id,{status:'queued',error:null});
        progress(id,{phase:'queued',percent:null});
        return {...row,status:'queued',error:null};
      } finally { options.preparing?.delete(id); }
    });
    void dispatch().catch(log);
    return result;
  }
  async function dispatch() {
    if (dispatching) return dispatching;
    dispatching=(async()=>{
      if (!options.enabled()) return;
      const rows=await options.listQueued();
      for (const row of rows) {
        if (options.pendingCount()>=6) break;
        options.enqueue(row.id);
      }
    })();
    try { await dispatching; } finally { dispatching=null; }
  }
  async function autoRecover() {
    if (recovering) return recovering;
    recovering=(async()=>{
      await dispatch();
      if (!options.enabled()) return;
      const rows=await options.listUploading();
      if (!rows.length) return;
      // Rotate bounded batches; an incomplete old upload must not starve others.
      const selected=[];
      for(let i=0;i<Math.min(6,rows.length);i++)selected.push(rows[(scanCursor+i)%rows.length]);
      scanCursor=(scanCursor+selected.length)%rows.length;
      for(const row of selected) {
        try { await prepare(row.id,{auto:true}); }
        catch(error) { log(error); }
      }
      await dispatch();
    })();
    try { await recovering; } finally { recovering=null; }
  }
  async function begin(id) {
    return locked(id,async()=>{
      const row=await options.read(id);
      if(!row||!['queued','processing'].includes(row.status))return null;
      if (controls.get(id)?.controller && !controls.get(id).signal.aborted) return null;
      await authorize(row);
      if(!options.enabled())return null;
      const controller=new AbortController();
      const control={controller,signal:controller.signal,progress:{stage:'downloading',label:labels.downloading,percent:null}};
      controls.set(id,control);
      try {
        await options.update(id,{status:'processing',error:null});
      } catch (error) {
        controller.abort();
        if (controls.get(id)===control) controls.delete(id);
        throw error;
      }
      return {session:{...row,status:'processing'},control,signal:controller.signal,onProgress:event=>{if(controls.get(id)===control)progress(id,event);}};
    });
  }
  async function assertActive(id, signal) {
    if(signal?.aborted)throw Object.assign(new Error('任务已停止，原片保留'),{name:'AbortError',code:'VIDEO_TASK_ABORTED'});
    const row=await options.read(id);
    if(!row||row.status!=='processing')throw Object.assign(new Error('任务已停止，原片保留'),{name:'AbortError',code:'VIDEO_TASK_ABORTED'});
    await authorize(row);
    if(signal?.aborted)throw Object.assign(new Error('任务已停止，原片保留'),{name:'AbortError',code:'VIDEO_TASK_ABORTED'});
    return row;
  }
  async function publish(id,signal,fn) {
    return locked(id,async()=>{
      await assertActive(id,signal);
      progress(id,{phase:'publishing',percent:null});
      // Stop/dismiss waits for this small commit boundary, then sees completed.
      return fn();
    });
  }
  async function change(id,action,actor) {
    return locked(id,async()=>{
      const row=await options.read(id);await authorize(row,actor,true);
      if(row.status==='completed' && action==='pause')return row;
      if(row.status==='dismissed')return row;
      if(row.status==='aborted')throw taskError('任务已取消，不能继续处理');
      const status=action==='dismiss'?'dismissed':'paused';
      controls.get(id)?.controller?.abort();
      options.removeQueued?.(id);
      await options.update(id,{status});
      return {...row,status};
    });
  }
  async function fail(id,error,control) {
    return locked(id,async()=>{
      if(error?.code==='VIDEO_TASK_ABORTED'||control?.signal?.aborted)return;
      if(control&&controls.get(id)!==control)return;
      const row=await options.read(id);
      if(!row||terminal.has(row.status)||row.status==='paused')return;
      await options.update(id,{status:'delivery_failed',error:String(error.message||'后台处理未完成').slice(0,1000)});
    });
  }
  function finish(id,control) {
    const current=controls.get(id);
    if(control?current===control:!current?.controller)controls.delete(id);
    void dispatch().catch(log);
  }
  return {prepare,dispatch,autoRecover,begin,assertActive,publish,pause:(id,actor)=>change(id,'pause',actor),dismiss:(id,actor)=>change(id,'dismiss',actor),fail,finish,progress,getProgress,parts};
}

module.exports={createProjectVideoTasks,taskError};
