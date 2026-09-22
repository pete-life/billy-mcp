import {createInterface} from 'node:readline/promises';
import {loadLocalConfig,resolveCompany} from './config.js';
import {BillyClient} from './client.js';
import {Store} from './store.js';
const [planId,outcome]=process.argv.slice(2);
if(!planId||!['applied','not_applied'].includes(outcome||''))throw new Error('Usage: npm run recover -- PLAN_ID applied|not_applied');
if(!process.stdin.isTTY)throw new Error('Recovery is an interactive operator action, not an MCP tool');
const c=loadLocalConfig(),client=new BillyClient(c.token,c.organizationId);await resolveCompany(c,client);await client.verifyOrganization();
const store=new Store(c.dataDir,c.inbox,c.organizationId),rl=createInterface({input:process.stdin,output:process.stdout});
try{
  const plan=store.plan(planId);
  if(plan.status==='executing'&&plan.executorPid){
    let alive=true;try{process.kill(plan.executorPid,0);}catch{alive=false;}
    if(alive)throw new Error('Executor process is still running. Stop it and verify the actual Billy result before recovery.');
  }
  console.log(JSON.stringify(plan,null,2));
  console.log('Inspect Billy now. Applied means the full intended effect is present. Not applied means NONE of the intended remote changes occurred. Partial operations must be completed/reversed and verified in Billy first. This command will not undo or retry any API write.');
  const evidence=await rl.question('Record the Billy record IDs and checks establishing this outcome (at least 30 characters): ');
  if(evidence.trim().length<30)throw new Error('Recovery requires concrete evidence');
  const confirm=await rl.question(`Type ${plan.id} to record the operator-verified outcome ${outcome}: `);
  if(confirm!==plan.id)throw new Error('Recovery cancelled');
  const resolved=store.recover(plan.id,outcome as 'applied'|'not_applied',evidence);
  console.log(`Recorded ${resolved.status}. Applied plans can never be replayed. A not-applied plan requires a fresh preview before retry.`);
}finally{rl.close();store.close();}
