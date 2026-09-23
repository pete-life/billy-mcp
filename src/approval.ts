import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {canonical} from './store.js';
import type {Config} from './config.js';

export type ApprovalEvidence={mode:'confirm'|'trusted_automation';at:string;scopeHash:string};
export class ApprovalGate {
  constructor(private config:Config,private server:McpServer){}
  async authorize(scope:{companyId:string;hash:string;details:unknown;authorization:string}):Promise<ApprovalEvidence> {
    if(!this.config.writes)throw new Error('Writes disabled. Enable BILLY_ALLOW_WRITES in the local profile.');
    const mode=this.config.approvalMode||'confirm';
    if(mode==='trusted_automation')return {mode,at:new Date().toISOString(),scopeHash:scope.hash};
    if(!this.server.server.getClientCapabilities()?.elicitation?.form)throw new Error('This MCP client does not support form elicitation; financial writes require a client approval or explicit local trusted_automation mode.');
    const message=`Approve this exact Billy accounting scope?\nCompany: ${scope.companyId}\nHash: ${scope.hash}\nAudit note: ${scope.authorization}\nComplete ordered scope:\n${canonical(scope.details)}`;
    let result;
    try {result=await this.server.server.elicitInput({mode:'form',message,requestedSchema:{type:'object',properties:{approve:{type:'boolean',title:'Approve exact scope',description:'Confirm the company, amounts, records and all ordered actions shown above.',default:false}},required:['approve']}});}
    catch {throw new Error('Client approval was unavailable; no accounting write was started.');}
    if(result.action!=='accept'||result.content?.approve!==true)throw new Error('Accounting write was not approved; no accounting write was started.');
    return {mode,at:new Date().toISOString(),scopeHash:scope.hash};
  }
}
