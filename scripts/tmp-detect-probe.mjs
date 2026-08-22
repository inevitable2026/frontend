import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const ROOT = process.cwd()
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) {
      let p = path.join(ROOT, spec.slice(2))
      for (const cand of [p, p + '.ts', p + '.tsx', path.join(p, 'index.ts')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return next(pathToFileURL(cand).href, ctx)
        }
      }
    }
    return next(spec, ctx)
  },
})

const { runDetect } = await import(pathToFileURL(path.join(ROOT, 'lib/detect/engine.ts')).href)
const { triggerRules } = await import(pathToFileURL(path.join(ROOT, 'lib/detect/rules/index.ts')).href)

const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/board/seed-facts.json'), 'utf8'))
const facts = seed.facts
const siteId = seed.siteId
const at = process.argv[2] ?? '2026-08-19T08:10:00+09:00'

const run = runDetect({ siteId, now: at, facts: facts.filter(f => Date.parse(f.observedAt) <= Date.parse(at)), rules: triggerRules })
console.log('runId', run.runId)
console.log('detections', run.detections.length)
for (const d of run.detections) console.log('  ', d.ruleId, d.detectedAt, 'conf', d.confidence, '|', d.summary.slice(0, 70))
console.log('created', run.created.length)
for (const i of run.created) console.log('  ', i.itemId, '|', i.status, '|', i.dueBy, '| draft=', i.draft !== null, '|', i.title.slice(0, 40))
