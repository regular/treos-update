
function makeConfig(d) {
  return Object.entries(d).map(p => {
    if (!Array.isArray(p[1])) {
      return p.join('\t')
    }
    return p[1].map(v=>`${p[0]}\t${v}`).join('\n')
  }).join('\n')
}

function makeBootEntry(d) {
  const options = d.options
  d = Object.assign({}, d)
  delete d.options

  const opts = 'options\t' + Object.entries(options).map( ([key, value]) => {
    if (value==true) return key
    return `${key}=${value}`
  }).join(' ')

  return [makeConfig(d), opts].join('\n')
}

module.exports = {
  makeConfig,
  makeBootEntry
}
