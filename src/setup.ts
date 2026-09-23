import {createInterface} from 'node:readline/promises';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {config} from './config.js';
import {BillyClient} from './client.js';
process.umask(0o077);
const c=config(), file=join(c.dataDir,'credentials.env');
if(!process.stdin.isTTY)throw new Error('Run setup in your own interactive terminal; token input is hidden.');
if(existsSync(file))throw new Error(`Configuration already exists at ${file}. Use it or explicitly move it aside before reconfiguration.`);
process.stdout.write('Billy company API token (hidden): ');
const token=await new Promise<string>((resolve,reject)=>{
  let value='';process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  const finish=()=>{process.stdin.setRawMode(false);process.stdin.off('data',onData);process.stdout.write('\n');};
  const onData=(chunk:string)=>{
    for(const char of chunk){
      if(char==='\u0003'){finish();reject(new Error('Cancelled'));return;}
      if(char==='\r'||char==='\n'){finish();resolve(value.trim());return;}
      if(char==='\u007f'){value=value.slice(0,-1);continue;}
      if(char.charCodeAt(0)>=32)value+=char;
    }
  };process.stdin.on('data',onData);
});
if(!/^[A-Za-z0-9._~+/-]+=*$/.test(token))throw new Error('Unexpected token format; no configuration written.');
const org=await new BillyClient(token,'').organization();
const rl=createInterface({input:process.stdin,output:process.stdout});
try{
  console.log(`Company: ${org.name}; CVR: ${org.registrationNo||'not provided'}; ID: ${org.id}`);
  const confirmed=await rl.question('Use this company? Type yes to confirm: ');
  if(confirmed.trim().toLowerCase()!=='yes')throw new Error('Company not confirmed; no configuration written');
  mkdirSync(c.dataDir,{recursive:true,mode:0o700});
  writeFileSync(file,`BILLY_ACCESS_TOKEN=${token}\nBILLY_ORGANIZATION_ID=${org.id}\nBILLY_ALLOW_WRITES=false\nBILLY_APPROVAL_MODE=confirm\nBILLY_ALLOW_BANK_MATCHING=false\n`,{mode:0o600,flag:'wx'});
  console.log(`Saved locally to ${file}. Writes are disabled. You can now run the MCP server.`);
}finally{rl.close();process.stdin.pause();}
