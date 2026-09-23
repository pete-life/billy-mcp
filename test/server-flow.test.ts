import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createServer} from '../src/server.js';
import type {BillyClient} from '../src/client.js';

for(const decision of ['accept','decline','unsupported'] as const)test(`integrated MCP write ${decision} keeps client approval, idempotency and sanitized evidence`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'billy-server-flow-'));
  let writes=0,forms=0;
  const contact={id:'fixture-contact',name:'Example supplier',countryId:'DK',isSupplier:true,isCustomer:false,
    accessCode:'fixture-secret-code',downloadUrl:'https://example.test/invoice?signature=fixture-signed-secret'};
  const api={verifyOrganization:async()=>({id:'fixture-org',name:'Example company',baseCurrencyId:'DKK'}),
    list:async()=>[],get:async()=>contact,write:async()=>{writes++;return {contacts:[contact]};}} as unknown as BillyClient;
  const {server,store}=createServer({token:'synthetic-not-a-real-token',organizationId:'fixture-org',dataDir:root,inbox:join(root,'inbox'),writes:true,bankMatching:false},api);
  const client=new Client({name:'integrated-client',version:'1'},decision==='unsupported'?{}:{capabilities:{elicitation:{form:{}}}});
  if(decision!=='unsupported')client.setRequestHandler(ElicitRequestSchema,async request=>{
    forms++;assert.match(request.params.message,/fixture-org/);assert.match(request.params.message,/Example supplier/);
    return decision==='accept'?{action:'accept' as const,content:{approve:true}}:{action:'decline' as const};
  });
  const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
  const call=async(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
  const data=(response:any)=>JSON.parse(response.content[0].text);
  try{
    await server.connect(serverTransport);await client.connect(clientTransport);
    const status=data(await call('billy_status',{}));assert.equal(status.approvalMode,'confirm');assert.equal(status.organization.baseCurrencyId,'DKK');
    const prepared=data(await call('billy_prepare',{operation:{kind:'create_contact',name:'Example supplier',countryId:'DK',isSupplier:true,isCustomer:false},reason:'Create this explicitly requested fixture supplier'}));
    assert.equal(prepared.status,'prepared');assert.ok(prepared.id);assert.ok(prepared.hash);
    const args={planId:prepared.id,expectedHash:prepared.hash,authorization:'User requested the exact fixture supplier'};
    const execution=await call('billy_execute',args);
    if(decision==='accept'){
      assert.equal(execution.isError,undefined);assert.equal(data(execution).status,'completed');assert.equal(writes,1);assert.equal(forms,1);
      assert.doesNotMatch(JSON.stringify(execution),/fixture-secret|fixture-signed|accessCode|downloadUrl/);
      const repeated=await call('billy_execute',args);assert.equal(data(repeated).status,'completed');assert.equal(writes,1);assert.equal(forms,1);
    }else{assert.equal(execution.isError,true);assert.equal(writes,0);assert.equal(store.plan(prepared.id).status,'prepared');}
  }finally{await client.close();await server.close();store.close();}
});
