#!/usr/bin/env node

import { readJson } from './util.ts'
import { executeDshWorker, type DshWorkerRequest } from './dsh.ts'

const requestPath = process.argv[2]
if (requestPath === undefined) throw new Error('dsh worker 缺少 request path')
const request = await readJson<DshWorkerRequest>(requestPath)
if (request === undefined) throw new Error(`dsh worker request 不存在：${requestPath}`)
await executeDshWorker(request)
