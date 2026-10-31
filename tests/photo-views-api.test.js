const test=require('node:test');
const assert=require('node:assert/strict');
const {withServer}=require('./support/video-api-server');
const url='https://proj2.likeduoduiyi.cn/silver-project-images/photo.jpg';
test('authorized DTO decorates images without writing fields; download checks identity after share policy and old clients still work',()=>withServer({},async ctx=>{
 const token=await ctx.login();
 const made=await ctx.api('/my/activity-projects',{method:'POST',token,body:{title:'views',media:[{type:'image',url,size:3000}]}});
 assert.equal(made.status,201);const id=made.data.project.id;
 const detail=await ctx.api(`/public/activity-projects/${id}`);
 assert.match(detail.data.project.media[0].thumbnailUrl||'',/w_640/);
 const saved=ctx.persisted().activity_projects.find(p=>p.id===id);const doc=typeof saved.doc==='string'?JSON.parse(saved.doc):saved.doc;
 assert.equal(doc.media[0].thumbnailUrl,undefined);
 assert.equal((await ctx.api(`/public/activity-projects/${id}/download?i=0&expectedUrl=wrong`)).status,409);
 assert.equal((await ctx.api(`/public/activity-projects/${id}/download?i=0`)).status,200);
 assert.equal((await ctx.api(`/my/activity-projects/${id}`)).status,401);
 await ctx.api(`/my/activity-projects/${id}`,{method:'PATCH',token,body:{shareEnabled:false}});
 assert.equal((await ctx.api(`/public/activity-projects/${id}/download?i=0&expectedUrl=wrong`)).status,404);
}));
test('video download-file identity mismatch is rejected before redirect and legacy redirect still works',()=>{
 const id='photo_download_guard',video='https://proj2.likeduoduiyi.cn/silver-project-videos/original.mp4';
 const doc={id,title:'guard',ownerId:'u_admin',status:'published',shareEnabled:true,media:[{type:'video',url:video}]};
 return withServer({seed:{users:[{id:'u_admin',username:'admin',role:'admin',doc:JSON.stringify({id:'u_admin',username:'admin',role:'admin',status:'active'})}],activity_projects:[{id,owner_id:'u_admin',status:'published',doc:JSON.stringify(doc)}]}},async ctx=>{
   assert.equal((await ctx.api(`/public/activity-projects/${id}/download-file?i=0&expectedUrl=wrong`)).status,409);
   const response=await fetch(`http://127.0.0.1:${ctx.port}/api/public/activity-projects/${id}/download-file?i=0`,{redirect:'manual'});assert.equal(response.status,302);
 });
});
test('public case filtering never queues derivatives for draft cases',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const source=fs.readFileSync(require.resolve('../server.js'),'utf8');const start=source.indexOf('function publicCase('),end=source.indexOf('\nfunction normalizeProjectMedia',start);let queued=0;
 const context={normalizeCase:c=>({...c}),photoViews:()=>({decorate:m=>{queued++;return m;}})};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 context.publicCase({status:'draft',media:[{type:'image',url}]});assert.equal(queued,0);
 context.publicCase({status:'published',media:[{type:'image',url}]});assert.equal(queued,1);
});
test('case download authenticates first, rejects reordered identity, and preserves legacy URL download',()=>{
 const crypto=require('node:crypto');const id='case_photo_identity',oldUrl='https://proj2.likeduoduiyi.cn/silver-images/old.jpg',newUrl='https://proj2.likeduoduiyi.cn/silver-images/new.jpg';
 const admin={id:'u_admin',username:'admin',role:'admin',status:'active',salt:'test',passwordHash:crypto.createHash('sha256').update('test:admin123').digest('hex')};
 const doc={id,title:'Reordered case',status:'published',media:[{type:'image',url:newUrl,size:100},{type:'image',url:oldUrl,size:100}]};
 return withServer({seed:{users:[{id:admin.id,username:admin.username,role:admin.role,doc:JSON.stringify(admin)}],cases:[{id,status:'published',doc:JSON.stringify(doc)}]}},async ctx=>{
  const route=`/public/cases/${id}/download?i=0`;assert.equal((await ctx.api(route+'&expectedUrl='+encodeURIComponent(oldUrl))).status,401);
  const token=await ctx.login();assert.equal((await ctx.api(route+'&expectedUrl='+encodeURIComponent(oldUrl),{token})).status,409);
  const legacy=await ctx.api(route,{token});assert.equal(legacy.status,200);assert.equal(legacy.data.url,newUrl);
  assert.equal((await ctx.api(route+'&expectedUrl='+encodeURIComponent(newUrl),{token})).status,200);
 });
});
