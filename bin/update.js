#!/usr/bin/env node

/* Usage: 
 *
 *   update [--config PATH-TO-SSB-CONFIG] [--wait SECS] [--tmpdir TMPDIR] --boot-vars "KEY1=VALUE1 KEY2=VALUE2" ISSUEFILE [REVROOT]
 *
 * ISSUEFILE is the path to treos-issue.json describing the current system
 * REVROOT is an ssb key. If the latest revision of this message differs from
 * the system described in ISSUEFILE, an update.tar file will be created in the
 * current working directory.
 * SECS wait number of seconds for update to have settled (during gossip)
 * KEYx, VALUEx are used in replacing placehoder strings in boot options. Defaults to contents of
 * /proc/cmdline.
*/

const os = require('os')
const crypto = require('crypto')
const fs = require('fs')
const {join, resolve, relative, dirname} = require('path')
const through2 = require('through2')
const multicb = require('multicb')
const tar = require('tar-stream')
const mv = require('mv')
const equal = require('deep-equal')
const bytes = require('human-size')

const bl = require('bl')
const toPull = require('stream-to-pull-stream')
const pull = require('pull-stream')
const debounce = require('pull-debounce')

const client = require('tre-cli-client')
const {isMsg} = require('ssb-ref')

const makeBootloaderConfigFiles = require('treos-bootconfig/systemd-boot')
const parseVars  = require('treos-bootconfig/parse-vars')

client( (err, ssb, conf, keys) => {
  if (err) {
    console.error(err.message)
    process.exit(1)
  }
  if (conf._.length<1) {
    console.error('USAGE: treos-update [--config CONFIG] [--wait SECS] ISSUE.JSON [REVROOT]')
    process.exit(1)
  }

  const bootVars = parseVars(conf['boot-vars'] || fs.readFileSync('/proc/cmdline', 'utf8'))
  const updateTar = conf.output || 'update.tar'
  const tmpfile = join(conf.tmpdir || os.tmpdir(), crypto.randomBytes(20).toString('hex'))

  console.log('Bootvars')
  console.log(bootVars)

  readIssueFile(updateTar, conf._[0], (err, issueKv) => {
    if (err) {
      console.error(err.message)
      process.exit(1)
    }
    runUpdate(issueKv)
  })

  function runUpdate(issueKv) {
    const issue = getIssue(issueKv)
    const revRoot = conf._[1] || revisionRoot(issueKv)
    if (!isMsg(revRoot)) {
      console.error(`${revRoot} is not a valid ssb message reference`)
      process.exit(1)
    }

    const currentSums = getChecksums(getFiles(issue))
    console.log('Current System')
    if (issueKv.key) {
      console.log(`System message id: ${issueKv.key}`)
    }
    const issueRevRoot = issueKv.value.content.revisionRoot
    const issueRevBranch = issueKv.value.content.revisionBranch
    if (issueRevRoot) {
      console.log(`System revisionRoot: ${issueRevRoot}`)
    }
    if (issueRevBranch) {
      console.log(`System revisionBranch: ${issueRevBranch}`)
    }
    console.log(currentSums)
    console.log('Bootloader')
    const currentBootloaderConfig = issue.bootloader
    console.dir(currentBootloaderConfig, {depth: 5})

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
      pull.asyncMap((kv, cb) =>{
        // if issueKv specifies revisionBranch,
        // and we are not in the process of switching to anither revRoot,
        // then we prevent downgrading by checking that issueKv's
        // revisionBranch is in the history of the update in question.
        if (issueRevRoot && issueRevRoot !== revisionRoot(kv)) {
          return cb(null, kv)
        }
        if (issueKv.key == kv.key) {
          console.error('We are up to date.')
          return cb(null, null)
        }
        if (!issueRevBranch) return cb(null, kv)
        if (issueRevBranch == kv.key) {
          console.error(`Prevented downgrading to ${kv.key}`)
          return cb(null, null)
        }
        pull(
          ssb.revisions.history(revRoot),
          pull.collect( (err, items)=>{
            if (err) return cb(err)
            if (items.find(x => x.key == issueRevBranch)) {
              return cb(null, kv)
            }
            console.error(`Prevented downgrading to ${kv.key}`)
            cb(null, null)
          })
        )
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
              const bootloaderConfigFiles = makeBootloaderConfigFiles(bootloaderConfig, bootVars)
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
          console.log('Preparing update')
        }
        return todo.length
      }),
      pull.asyncMap( (todo, cb)=>{
        const output = tmpfile
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
        console.log(`Written ${outputFile}, moving to ${updateTar}`)
        mv(outputFile, updateTar, err =>{
          if (err) {
            console.error(err.message)
            ssb.close()
            process.exit(1)
          }
          ssb.close()
          console.log('Done')
          process.exit(0)
        })
      }, err=>{
        if (err && err !== true) {
          console.error(err.message)
          process.exit(1)
        }
        ssb.close()
      })
    )
  }

  function ensureLocal(blob, cb) {
    ssb.blobs.has(blob, (err, has) => {
      if (err) return cb(err)
      console.log(`Blob ${has ? 'is' : 'is not yet'} present locally`)
      if (has) {
        return cb(null)
      }
      console.log('Requesting blob ...')
      ssb.blobs.want(blob, (err, has)=>{
        if (err) return cb(err)
        console.log('Received blob')
        cb(null, has)
      }) 
    })
  }

})
  
function extractIssue(updateTar, cb) {
  const extract = tar.extract()
  const buffer = bl()
  let found =false
  extract.on('entry', function(header, stream, next) {
    const {name} = header
    stream.on('end', function() {
      next() // ready for next entry
    })
    if (name == 'treos-issue.json') {
      console.log('Found treos-issue.json')
      stream.pipe(buffer)
      found = true
    } else {
      stream.resume() // just auto drain the stream
    }
  })                 
  extract.on('finish', function() {
    console.log('Finished reading tar')
    cb(found ? null : new Error('No entry for treos-issue.json found in tar'), buffer.toString('utf8'))
  })
  fs.createReadStream(updateTar).pipe(extract)
}

function readIssueFile(updateTar, path, cb) {
  if (fs.existsSync(updateTar)) {
    console.log('Output file exists. Reading packed treos-issue.json')
    extractIssue(updateTar, handleContent)
  } else {
    const issueFile = resolve(path)
    console.error(`reading ${issueFile}`)
    const fileContent = fs.readFileSync(issueFile)
    handleContent(null, fileContent)
  }

  function handleContent(err, fileContent) {
    if (err) return cb(err)
    let issue
    try {
      issue = JSON.parse(fileContent)
    } catch(err) {
      return cb(err)
    }
    cb(null, issue)
  }
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

function revisionRoot(kv) {
  return kv.value.content.revisionRoot || kv.key
}
