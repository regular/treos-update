#!/usr/bin/env node

/* Usage: update [--config PATH-TO-SSB-CONFIG] [--wait SECS] ISSUEFILE REVROOT
 *
 * ISSUEFILE is the path to treos-issue.json describing the current system
 * REVROOT is an ssb key. If the latest revision of this message differs from
 * the system described in ISSUEFILE, an update.tar file will be created in the
 * current working directory.
 * SECS wait number of seconds for update to have settled (during gossip)
*/

const crypto = require('crypto')
const through2 = require('through2')
const fs = require('fs')
const {join, resolve, relative, dirname} = require('path')
const multicb = require('multicb')
const client = require('tre-cli-client')
const {isMsg} = require('ssb-ref')
const tar = require('tar-stream')
const equal = require('deep-equal')

const toPull = require('stream-to-pull-stream')
const pull = require('pull-stream')
const debounce = require('pull-debounce')
const bytes = require('human-size')

const makeBootloaderConfigFiles = require('../lib/systemd-boot')

client( (err, ssb, conf, keys) => {
  if (err) {
    console.error(err.message)
    process.exit(1)
  }
  if (conf._.length<2) {
    console.error('USAGE: treos-update [--config CONFIG] [--wait SECS] ISSUE.JSON REVROOT')
    process.exit(1)
  }

  const issueKv = readIssueFile(conf._[0])
  const issue = getIssue(issueKv)
  const revRoot = conf._[1]
  if (!isMsg(revRoot)) {
    console.error(`${revRoot} is not a valid ssb message reference`)
    process.exit(1)
  }

  const currentSums = getChecksums(getFiles(issue))
  console.log('Current System')
  if (issueKv.key) {
    console.log(`System message id: ${issue.key}`)
  }
  console.log(currentSums)
  console.log('Bootloader')
  const currentBootloaderConfig = issue.bootloader
  console.log(JSON.stringify(currentBootloaderConfig, null, 2))

  /*
  */

  let updateKv
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
      updateKv = kv
    }),
    debounce(conf.wait !== undefined ? conf.wait : 3000),
    pull.through(kv => {
      console.log('Checking update')
    }),
    pull.map(kv => getIssue(kv)),
    pull.map(issue => {
      return {
        files: getFiles(issue),
        bootloaderConfig: issue.bootloader
      }
    }),
    pull.map( ({files, bootloaderConfig}) => {
      return {
        checksums: getChecksums(files),
        bootloaderConfig
      }
    }),
    pull.asyncMap(({checksums, bootloaderConfig}, cb) =>{
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
        pull.collect((err, result)=>{
          if (err) return cb(err)
          if (!equal(bootloaderConfig, currentBootloaderConfig)) {
            console.log('Bootloader config has changed')
            const bootloaderConfigFiles = makeBootloaderConfigFiles(bootloaderConfig)
            result = result.concat(Object.entries(bootloaderConfigFiles).map( ([filename, content]) => {
              return {filename, content}
            }))
          } else {
            console.log('Bootloader config is identical')
          }
          cb(null, result)
        })
      )
    }),
    pull.filter(todo=>{
      if (!todo.length) {
        console.log('Nothing to do')
      } else {
        console.log('Applying update')
      }
      return todo.length
    }),
    pull.asyncMap( (todo, cb)=>{
      const output = conf.output || 'update.tar'
      console.log(`Writing ${output}`)
      const pack = tar.pack()
      const outputStream = fs.createWriteStream(output)
      pack.pipe(outputStream)
      pack.entry({name: 'treos-issue.json'}, JSON.stringify(updateKv, null, 2))
      pull(
        pull.values(todo),
        pull.asyncMap( ({filename, checksum, content, source}, cb)=> {
          if (content) {
            console.log(`Packing ${filename}`)
            pack.entry({name: filename}, content)
            return cb(null)
          }
          let [shasum, size] = checksum.split('#')
          size = Number(size)
          shasum = shasum.split('.')[0]
          console.log(`Packing ${filename} (${size} = ${bytes(size)})`)
          const entry = pack.entry({name: filename, size}, err =>{
            console.log(`tar entry for ${filename} complete`)
            if (err) console.error(err.message)
            cb(err || null)
          })
          if (source) {
            const sourcePath = resolve(conf['boot-dir'] || '/boot', source)
            console.log(`Reading from ${sourcePath}`)
            const hash = crypto.createHash('sha256')
            fs.createReadStream(sourcePath)
              .pipe(through2(function (chunk, enc, callback) {
                this.push(chunk)
                hash.update(chunk)
                callback()
              }))
              .pipe(entry)
              .on('finish', ()=>{
                const sha = hash.digest('base64')
                if (sha !== shasum) {
                  console.error(`checksum mismatch! ${sha} !== ${shasum}`)
                  process.exit(1)
                } else {
                  console.log(`${sourcePath} checksum matches`)
                }
              })
          } else {
            const blob = `&${shasum}.sha256`
            console.log(`Loading from blob ${blob}`)
            
            ensureLocal(blob, err=>{
              if (err) {
                console.error(err.message)
                return cb(err)
              }
              console.log('Received blob')
              let total = 0 
              const hash = crypto.createHash('sha256')
              pull(
                ssb.blobs.get(blob),
                pull.through(x=>{
                  total += x.length
                  process.stdout.write(`${total} / ${size}\r`)
                }),
                pull.through(x=>{
                  hash.update(x)
                }),
                toPull.sink(entry, err =>{
                  const sha = hash.digest('base64')
                  if (sha !== shasum) {
                    console.error(`checksum mismatch! ${sha} !== ${shasum}`)
                    process.exit(1)
                  } else {
                    console.log(`${filename} checksum matches`)
                  }
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

  function ensureLocal(blob, cb) {
    ssb.blobs.has(blob, (err, has) => {
      if (err) return cb(err)
      console.log(`Blob ${has ? 'is' : 'is not yet'} present locally`)
      if (has) {
        return cb(null)
      }
      console.log('Requesting blob ...')
      ssb.blobs.want(blob, cb) 
    })
  }

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
