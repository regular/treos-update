const WatchMerged = require('tre-prototypes')
const WatchHeads = require('tre-watch-heads')
const Value = require('mutant/value')
const watch = require('mutant/watch')
//const {isMsg} = require('ssb-ref')
const debug = require('debug')('await-stable')

module.exports = awaitStable

function awaitStable(ssb, keyOrRevRoot, timeToSettle, cb) {
  const watchMerged = WatchMerged(ssb)
  const watchHeads = WatchHeads(ssb)

  debug(`keyOrRevRoot: "${keyOrRevRoot}"`)

  // first let's find out if keyOrRevRoot refers to a specific revision
  // or a revisionRoot.
  // revisions.get() will wait for the message to arrive via gossip
  ssb.revisions.get(keyOrRevRoot, {meta: true}, (err, {meta, value}) => {
    if (err) return cb(err)
    let kvObs
    if (!meta.original) {
      // it's a specific revision
      // but we still use the latest prototypes!
      debug('request for specific revision')
      kvObs = Value({key: keyOrRevRoot, value}) // this won't change
    } else {
      debug('request for latest revision')
      // watch this revisionRoot
      kvObs = watchHeads(keyOrRevRoot)
    }
    let timer, release
    release = watch(watchMerged(kvObs), kv => {
      if (!kv) return
      debug('change detected, new revision is %s', kv.key)
      if (timer) clearTimeout(timer)
      timer = setTimeout( ()=> {
        release()
        debug('message seems to have settled')
        cb(null, kv)
      }, timeToSettle)
    })
  })
}

