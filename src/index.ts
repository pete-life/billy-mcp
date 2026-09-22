#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createServer} from './server.js';
import {BillyClient} from './client.js';
import {config,resolveCompany} from './config.js';
process.umask(0o077);
const settings=config();
const client=new BillyClient(settings.token,settings.organizationId);
await resolveCompany(settings,client);
const {server,store}=createServer(settings,client);
await server.connect(new StdioServerTransport());
process.on('SIGTERM',async()=>{await server.close();store.close();process.exit(0);});
