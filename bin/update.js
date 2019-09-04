#!/usr/bin/env node

/* Usage: update [--config PATH-TO-SSB-CONFIG] [--wait SECS] ISSUEFILE REVROOT
 *
 * ISSUEFILE is the path to treos-issue.json describing the current system
 * REVROOT is an ssb key. If the latest revision of this message differs from
 * the system described in ISSUEFILE, an update.tar file will be created in the
 * current working directory.
 * SECS wait number of seconds for update to have settled (during gossip)
*/

const fs = require('fs')
const {join, resolve, relative, dirname} = require('path')
const multicb = require('multicb')
const client = require('tre-cli-client')
const {isMsg} = require('ssb-ref')
const tar = require('tar-stream')

const toPull = require('stream-to-pull-stream')
//const toStram = require('pull-stream-to-stream')
const pull = require('pull-stream')
const debounce = require('pull-debounce')
const bytes = require('human-size')
/*
const file = require('pull-file')
const paramap = require('pull-paramap')
const htime = require('human-time')
*/

client( (err, ssb, conf, keys) => {
  if (err) {
    console.error(err.message)
    process.exit(1)
  }
  if (conf._.length<2) {
    console.error('USAGE: treos-update [--config CONFIG] [--wait SECS] ISSUE.JSON REVROOT')
    process.exit(1)
  }

  const issue = getIssue(readIssueFile(conf._[0]))
  const revRoot = conf._[1]
  if (!isMsg(revRoot)) {
    console.error(`${revRoot} is not a valid ssb message reference`)
    process.exit(1)
  }

  const currentSums = getChecksums(getFiles(issue))
  console.log('Current System')
  console.log(currentSums)
  console.log()
  console.log('Update')

  let currentKv
  pull(
    ssb.revisions.heads(revRoot, {
      live: true,
      sync: false,
      meta: true,
      values: true,
      maxHeads: 1,
      allowAllAuthors: false
    }),
    pull.map( mh =>{
      const {meta, heads} = mh
      return heads[0]
    }),
    pull.filter(),
    pull.through(kv => {
      console.log(`Found update ${kv.key}`)
      currentKv = kv
    }),
    debounce(conf.wait !== undefined ? conf.wait : 3000),
    pull.map(kv => getIssue(kv)),
    pull.map(issue => getFiles(issue)),
    pull.map(files => getChecksums(files)),
    pull.asyncMap((checksums, cb) =>{
      pull(
        pull.values(Object.entries(checksums)),
        pull.filter( ([filename, checksum]) =>{
          if (currentSums[filename] == checksum) {
            console.log(`${filename} is up to date`)
            return false
          }
          console.log(`${filename} needs update`)
          return true
        }),
        pull.map( ([filename, checksum])=>{
          const currentFile = Object.entries(currentSums).find( ([key, value]) => value == checksum)
          if (currentFile) return {
            filename, checksum, source: currentFile[0]
          }
          return {filename, checksum}
        }),
        pull.collect(cb)
      )
    }),
    pull.filter(),
    pull.asyncMap( (todo, cb)=>{
      const output = conf.output || 'update.tar'
      console.log(`Writing ${output}`)
      const pack = tar.pack()
      const outputStream = fs.createWriteStream(output)
      pack.pipe(outputStream)
      pack.entry({name: 'treos-issue.json'}, JSON.stringify(currentKv, null, 2))
      pull(
        pull.values(todo),
        pull.asyncMap( ({filename, checksum, source}, cb)=> {
          let [shasum, size] = checksum.split('#')
          size = Number(size)
          console.log(`Packing ${filename} (${size} = ${bytes(size)})`)
          const entry = pack.entry({name: filename, size}, err =>{
            console.log('entry done')
            if (err) console.error(err.message)
            cb(err || null)
          })
          if (source) {
            const sourcePath = resolve(conf.boot || '/boot', source)
            console.log(`Reading from ${sourcePath}`)
            fs.createReadStream(sourcePath).pipe(entry)
          } else {
            const blob = `&${shasum}`
            console.log(`Loading from blob ${blob}`)
            ssb.blobs.has(blob, (err, has) => {
              if (err) return cb(err)
              console.log(`Blob present locally: ${has}`)
            })
            ssb.blobs.want(blob, (err, has)=>{
              if (err) return cb(err)
              let total = 0 
              pull(
                ssb.blobs.get(blob),
                pull.through(x=>{
                  total += x.length
                  console.log(`${total} / ${size}`)
                }),
                toPull.sink(entry, err =>{
                  console.log('blob sink done')
                  if (err) console.error(err.message)
                })
              )
            })
          }
        }),
        pull.onEnd(err=>{
          if (err) return cb(err)
          pack.finalize()
          outputStream.on('close', err => {
            if (err) return cb(err)
            cb(null, output)
          })
        })
      )
    }),
    pull.drain(outputFile=>{
      console.log(`Written ${outputFile}.`)
      if (!conf.live) {
        ssb.close()
        process.exit(0)
      }
    }, err=>{
      if (err && err !== true) {
        console.error(err.message)
        process.exit(1)
      }
      ssb.close()
      console.log('Done')
    })
  )
})
  
function readIssueFile(path) {
  const issueFile = resolve(path)
  console.error('issue:', issueFile)

  let issue
  try {
    issue = JSON.parse(fs.readFileSync(issueFile))
  } catch(err) {
    console.error(err.message)
    process.exit(1)
  }
  return issue
}

function getIssue(kv) {
  if (!kv.value) return kv
  return kv.value.content
}

function getChecksums(files) {
  return files.reduce( (acc, {name, checksum, size})=>{
    acc[name] = checksum + '#' + size
    return acc
  }, {})
}

function getFiles(issue) {
  const keys = 'kernels initcpios diskImages'.split(' ')
  return keys.reduce( (acc, key) => {
    Object.keys(issue[key]).map(k=>{
      const o = issue[key][k]
      acc.push({
        name: k,
        type: key,
        path: o.path,
        checksum: o.checksum,
        size: o.size
      })
    })
    return acc
  }, [])
}
