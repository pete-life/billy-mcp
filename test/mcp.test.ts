import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio MCP handshake, tool schemas, prompt and guarded errors',async()=>{
  const root=mkdtempSync(join(tmpdir(),'billy-mcp-'));
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{PATH:process.env.PATH!,BILLY_DATA_DIR:root,BILLY_ORGANIZATION_ID:'example-company'},stderr:'pipe'});
  const client=new Client({name:'integration-test',version:'1.0.0'});
  try {
    await client.connect(transport);const {tools}=await client.listTools();assert.equal(tools.length,17);
    for(const name of ['billy_trial_balance','billy_profit_loss','billy_outstanding','billy_period_expenses'])assert.ok(tools.find(t=>t.name===name)?.annotations?.readOnlyHint);
    assert.ok(tools.find(t=>t.name==='billy_execute')?.annotations?.destructiveHint);
    const status=await client.callTool({name:'billy_status',arguments:{}});assert.equal(status.isError,undefined);assert.match(JSON.stringify(status),/tokenConfigured/);
    const invalid=await client.callTool({name:'billy_prepare',arguments:{operation:{kind:'create_payment',cashAmount:-1},reason:'Bad payment'}});assert.equal(invalid.isError,true);
    const missing=await client.callTool({name:'billy_list',arguments:{resource:'bills'}});assert.equal(missing.isError,true);assert.match(JSON.stringify(missing),/not configured/);
    const prompt=await client.getPrompt({name:'bookkeeping-period',arguments:{start:'2026-09-01',end:'2026-09-22'}});
    assert.match(JSON.stringify(prompt),/2026-09-01 through 2026-09-22/);
    assert.ok(JSON.stringify(prompt).includes(join(process.cwd(),'skills','billy-bookkeeping')));
  }finally{await client.close();}
});
test('launcher loads local credentials configuration without embedding it in MCP config',async()=>{
  const root=mkdtempSync(join(tmpdir(),'billy-launch-'));
  writeFileSync(join(root,'credentials.env'),'BILLY_ORGANIZATION_ID=example-company\nBILLY_ALLOW_WRITES=true\n',{mode:0o600});
  const client=new Client({name:'launch-test',version:'1.0.0'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/launch.js'],env:{PATH:process.env.PATH!,BILLY_DATA_DIR:root},stderr:'pipe'}));
    const result=await client.callTool({name:'billy_status',arguments:{}});const text=JSON.stringify(result);
    assert.match(text,/example-company/);assert.match(text,/writesEnabled\\": true/);assert.match(text,/tokenConfigured\\": false/);
  }finally{await client.close();}
});
