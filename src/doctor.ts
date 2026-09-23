import {loadLocalConfig} from './config.js';
import {BillyClient} from './client.js';
import {sanitizeText} from './presentation.js';
const c=loadLocalConfig();
if(!c.token){console.log('Missing BILLY_ACCESS_TOKEN. Create a company API token in Billy and save it using billy-mcp setup. Do not paste it in chat.');process.exitCode=1;}
else {
  try {
    const client=new BillyClient(c.token,c.organizationId);
    const org=c.organizationId?await client.verifyOrganization():await client.organization();
    console.log(JSON.stringify({connected:true,organization:{id:org.id,name:org.name,registrationNo:org.registrationNo},pinned:Boolean(c.organizationId),writesEnabled:c.writes,bankMatchingEnabled:c.bankMatching,approvalMode:c.approvalMode||'confirm'},null,2));
  }catch(e){console.error(e instanceof Error?sanitizeText(e.message):'Connection failed');process.exitCode=1;}
}
