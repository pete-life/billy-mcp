import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { BillyClient } from './client.js';
export interface Config { token: string; organizationId: string; dataDir: string; inbox: string; writes: boolean; bankMatching: boolean; approvalMode?: 'confirm'|'trusted_automation' }
export function config(env = process.env): Config {
  const approvalMode=env.BILLY_APPROVAL_MODE||'confirm';
  if(approvalMode!=='confirm'&&approvalMode!=='trusted_automation')throw new Error('BILLY_APPROVAL_MODE must be confirm or trusted_automation');
  const dataDir = resolve(env.BILLY_DATA_DIR || `${homedir()}/.local/share/billy-mcp`);
  return {token: env.BILLY_ACCESS_TOKEN || '', organizationId: env.BILLY_ORGANIZATION_ID || '', dataDir,
    inbox: resolve(env.BILLY_RECEIPT_INBOX || `${dataDir}/inbox`), writes: env.BILLY_ALLOW_WRITES === 'true', bankMatching: env.BILLY_ALLOW_BANK_MATCHING === 'true',approvalMode};
}
export function loadLocalConfig(): Config {
  const path=resolve(config().dataDir,'credentials.env');
  if(existsSync(path))process.loadEnvFile(path);
  return config();
}
export async function resolveCompany(settings:Config,client:BillyClient) {
  if(settings.token&&!settings.organizationId){
    const organization=await client.organization();
    settings.organizationId=organization.id;client.organizationId=organization.id;
  }
  return settings;
}
