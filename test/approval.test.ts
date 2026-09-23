import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {McpServer as RealMcpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ApprovalGate} from '../src/approval.js';
import type {Config} from '../src/config.js';

const scope={companyId:'fixture-company',hash:'a'.repeat(64),details:{ordered:[{kind:'create_bill',amount:123.45},{kind:'approve',id:'bill-1'}]},authorization:'Fixture user authorized this bill'};
const settings:Config={token:'',organizationId:'fixture-company',dataDir:'/unused',inbox:'/unused',writes:true,bankMatching:false};
function client(capabilities:unknown,result:unknown){
  const messages:string[]=[];
  const server={server:{getClientCapabilities:()=>capabilities,elicitInput:async(params:{message:string})=>{messages.push(params.message);return result;}}} as unknown as McpServer;
  return {server,messages};
}

test('client form accept approves exact company, ordered scope and hash',async()=>{
  const {server,messages}=client({elicitation:{form:{}}},{action:'accept',content:{approve:true}});
  const evidence=await new ApprovalGate(settings,server).authorize(scope);
  assert.equal(evidence.mode,'confirm');assert.equal(evidence.scopeHash,scope.hash);
  assert.match(messages[0]!,/fixture-company/);assert.match(messages[0]!,/123.45/);
  assert.match(messages[0]!,new RegExp(scope.hash));assert.match(messages[0]!,/create_bill/);
});
test('decline, cancel and false form content never authorize',async()=>{
  for(const response of [{action:'decline'},{action:'cancel'},{action:'accept',content:{approve:false}}]){
    const {server}=client({elicitation:{form:{}}},response);
    await assert.rejects(()=>new ApprovalGate(settings,server).authorize(scope),/not approved/);
  }
});
test('unsupported or failed elicitation fails closed; writes switch still applies',async()=>{
  const unsupported=client({}, {action:'accept',content:{approve:true}});
  await assert.rejects(()=>new ApprovalGate(settings,unsupported.server).authorize(scope),/does not support/);
  assert.equal(unsupported.messages.length,0);
  const failed={server:{getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async()=>{throw new Error('unsupported');}}} as unknown as McpServer;
  await assert.rejects(()=>new ApprovalGate(settings,failed).authorize(scope),/unavailable/);
  await assert.rejects(()=>new ApprovalGate({...settings,writes:false,approvalMode:'trusted_automation'},unsupported.server).authorize(scope),/Writes disabled/);
});
test('trusted automation is explicit local config and does not ask client',async()=>{
  const {server,messages}=client({}, {action:'decline'});
  const evidence=await new ApprovalGate({...settings,approvalMode:'trusted_automation'},server).authorize(scope);
  assert.equal(evidence.mode,'trusted_automation');assert.equal(messages.length,0);
});
test('SDK form elicitation round trip accepts or declines the exact scope',async()=>{
  for(const approved of [true,false]){
    const server=new RealMcpServer({name:'approval-fixture',version:'1.0.0'});
    const gate=new ApprovalGate(settings,server);
    server.registerTool('fixture_write',{description:'Synthetic approval probe',inputSchema:{}},async()=>{
      try{await gate.authorize(scope);return {content:[{type:'text' as const,text:'approved'}]};}
      catch(error){return {isError:true,content:[{type:'text' as const,text:(error as Error).message}]};}
    });
    const client=new Client({name:'approval-test',version:'1.0.0'},{capabilities:{elicitation:{form:{}}}});
    const seen:string[]=[];
    client.setRequestHandler(ElicitRequestSchema,async request=>{
      seen.push(request.params.message);
      return approved?{action:'accept' as const,content:{approve:true}}:{action:'decline' as const};
    });
    const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(serverTransport);await client.connect(clientTransport);
      const result=await client.callTool({name:'fixture_write',arguments:{}});
      assert.equal(result.isError,approved?undefined:true);
      assert.equal(seen.length,1);assert.match(seen[0]!,new RegExp(scope.hash));
    }finally{await client.close();await server.close();}
  }
});
