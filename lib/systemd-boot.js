function makeBootloaderConfig(bootloader) {
  const config = makeConfig(bootloader.config)
  const entries = Object.entries(bootloader.entries).map( ([filename, fields]) =>{
    const content = makeBootEntry(fields)
    return {filename, content}
  })

  return entries.reduce( (acc, {filename, content})=>{
    acc[`loader/entries/${filename}`] = content + '\n'
    return acc
  }, {
    'loader/loader.conf': config + '\n'
  })
}

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

module.exports = makeBootloaderConfig
