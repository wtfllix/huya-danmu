#!/usr/bin/env node
// Diagnostic-only TARS/JCE structure scanner. It never names fields or infers
// Huya business meaning — it only reports offset / tag / type / length / nesting
// so raw capture files can be compared structurally.
//
// usage: node scripts/scan-tars-packet.js [--signature] <file.bin>
const fs = require('node:fs')
const { scanTarsBuffer, scanTarsSignatures } = require('../src/huya/tars-scanner')

function main() {
  const signature = process.argv[2] === '--signature'
  const file = process.argv[signature ? 3 : 2]
  if (!file) {
    console.error('usage: node scripts/scan-tars-packet.js [--signature] <file.bin>')
    process.exit(2)
  }
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`)
    process.exit(2)
  }
  const result = signature ? scanTarsSignatures(buffer) : scanTarsBuffer(buffer)
  if (!signature) process.stdout.write(result.output)
  else {
    process.stdout.write(result.output)
    const list = result.signatures.list
    if (list) {
      process.stdout.write(`LIST tag=${list.tag} length=${list.count} start=${list.offset} end=${list.endOffset}\n`)
      for (const item of result.signatures.items) {
        process.stdout.write(`item[${item.index}] start=${item.startOffset} end=${item.endOffset} ` +
          `bytes=${item.bytesConsumed} next=${item.nextOffset}\n${item.text}\n`)
      }
    } else {
      process.stdout.write('LIST tag=none\n')
    }
  }
  // Let stdout flush before the shell observes the diagnostic exit status.
  process.exitCode = result.aborted ? 1 : 0
}

if (require.main === module) main()

module.exports = { main }
