var Slocket = require('../')
var rimraf = require('rimraf')
var t = require('tap')
t.jobs = 1

if (typeof Promise === 'undefined')
  Promise = require('bluebird')

t.teardown(function () {
  names.forEach(function (n) {
    clear(n)
  })
})

var names = []
var lockPrefix = (process.platform === 'win32')
  ? ('\\\\.\\pipe\\' + __dirname + '\\') : (__dirname + '/')
function filename (n) {
  names.push(n)
  return lockPrefix + n
}
function clear (n) {
  rimraf.sync(lockPrefix + n)
}

t.test('3 parallel locks', function (t) {
  var locks = []
  clear('3-parallel')
  var file = filename('3-parallel')

  // also tests returning a promise
  for (var i = 0; i < 3; i++) {
    locks[i] = Slocket(file)
  }

  setInterval(function () {
    var h = has()
    if (h.filter(h => h).length > 1)
      throw new Error('double-lock: ' + JSON.stringify(h))
  }, 1000).unref()

  function has () {
    return locks.map(function (l, i) {
      return l.has
    })
  }

  t.same(has(), [ false, false, false ], 'no locks acquired sync')

  locks.forEach(function (l, i) {
    l.then(acquired(i))
  })

  var got = []
  function acquired (i) { return function (lock) {
    t.comment('acquired %d', i)
    t.equal(got.indexOf(i), -1, 'should not have gotten already')
    got.push(i)
    var expect = [false, false, true]
    t.same(has().sort(), expect, 'should have exactly 1 lock')
    t.isa(lock, Slocket)
    t.test('should not look like a promise or deferred', function (t) {
      t.equal(lock.then, undefined)
      t.equal(lock.catch, undefined)
      t.equal(lock.resolve, undefined)
      t.equal(lock.reject, undefined)
      t.end()
    })
    setTimeout(function () {
      lock.release()
    }, 100)
  }}

  Promise.all(locks).then(function (locks) {
    setTimeout(function () {
      t.same(has(), [false, false, false], 'no remaining locks')
      t.same(got.sort(), [ 0, 1, 2 ], 'got all 3 locks')
      clear('3-parallel')
      t.end()
    }, 100)
  })
})

// these would get up to or near 100% coverage
t.test('3 serial locks', function (t) {
  clear('3-serial')
  var file = filename('3-serial')
  t.teardown(clear.bind(null, '3-serial'))
  function go (i) {
    if (i === 3)
      return t.end()
    Slocket(file, function (er, lock) {
      if (er)
        throw er
      t.pass('got lock ' + i)
      lock.release()
      go(i+1)
    })
  }
  go(0)
})

t.test('staggered', function (t) {
  clear('3-staggered')
  var file = filename('3-staggered')
  t.teardown(clear.bind(null, '3-staggered'))

  var set = []
  Slocket(file).then(function (lock) {
    set[0] = lock
    t.equal(lock.type(), 'server')
    Slocket(file, function (er, lock) {
      t.equal(lock.type(), 'connection')
      set[1] = lock

      Slocket(file, function (er, lock) {
        t.equal(lock.type(), 'connection')
        lock.release()
        t.end()
      })
      setTimeout(function () {
        lock.release()
      }, 100)
    }).on('connect', function () {
      lock.release()
    })
  })
})

t.test('server disconnect', function (t) {
  var spawn = require('child_process').spawn
  var node = process.execPath
  var module = require.resolve('../')
  var file = filename('server-disconnect')
  var prog = 'var lock = require(process.argv[1])' +
             '(process.argv[2])\n' +
             'lock.then(function () { console.log("1") })\n' +
             'setTimeout(function() {}, 10000)\n' +
             'process.on("SIGHUP", lock.release)\n'
  var child = spawn(node, ['-e', prog, module, file])
  child.stderr.pipe(process.stderr)
  child.stdout.on('data', function () {
    // now we know that the server has the lock
    var didKill = false
    setTimeout(function () {
      child.kill('SIGHUP')
    })

    var clients = [
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock)
    ]
    Promise.all(clients).then(t.end)

    function onLock (er, lock) {
      var has = clients.filter(function (c) { return c.has })
      t.equal(has.length, 1, 'always exactly one lock')
      if (!didKill) {
        didKill = true
        child.kill('SIGINT')
        setTimeout(lock.release, 100)
      } else
        lock.release()
    }
  })
})

t.test('server process graceful exit', function (t) {
  var spawn = require('child_process').spawn
  var node = process.execPath
  var module = require.resolve('../')
  var file = filename('server-disconnect')
  var prog = 'var lock = require(process.argv[1])' +
             '(process.argv[2])\n' +
             'lock.then(function () { console.log("1") })\n' +
             'var t = setTimeout(function() {}, 10000)\n' +
             'process.on("SIGHUP", function () {\n' +
             '  lock.release()\n' +
             '  process.exit()\n' +
             '})\n'
  var child = spawn(node, ['-e', prog, module, file])
  var childClosed = false
  child.on('close', function (code, signal) {
    childClosed = true
    t.equal(code, 0)
    t.equal(signal, null)
  })

  child.stderr.pipe(process.stderr)
  child.stdout.on('data', function () {
    // now we know that the server has the lock
    var didKill = false
    setTimeout(function () {
      child.kill('SIGHUP')
    })

    var clients = [
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock)
    ]
    Promise.all(clients).then(function () {
      t.ok(childClosed, 'child process exited gracefully')
      t.end()
    })

    function onLock (er, lock) {
      var has = clients.filter(function (c) { return c.has })
      t.equal(has.length, 1, 'always exactly one lock')
      setTimeout(lock.release, 100)
    }
  })
})

t.test('server process graceful exit without release', function (t) {
  var spawn = require('child_process').spawn
  var node = process.execPath
  var module = require.resolve('../')
  var file = filename('server-disconnect')
  var prog = 'var lock = require(process.argv[1])' +
             '(process.argv[2])\n' +
             'lock.then(function () { console.log("1") })\n' +
             'var t = setTimeout(function() {}, 10000)\n'
  var child = spawn(node, ['-e', prog, module, file])
  var childClosed = false
  child.on('close', function (code, signal) {
    childClosed = true
    t.equal(code, null)
    t.equal(signal, 'SIGHUP')
  })

  child.stderr.pipe(process.stderr)
  child.stdout.on('data', function () {
    // now we know that the server has the lock
    var didKill = false
    setTimeout(function () {
      child.kill('SIGHUP')
    })

    var clients = [
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock),
      Slocket(file, onLock)
    ]
    Promise.all(clients).then(function () {
      t.ok(childClosed, 'child process exited gracefully')
      t.end()
    })

    function onLock (er, lock) {
      var has = clients.filter(function (c) { return c.has })
      t.equal(has.length, 1, 'always exactly one lock')
      setTimeout(lock.release, 100)
    }
  })
})

t.test('server object emit error after being removed')
t.test('try to lock on a non-socket, auto-lock once removed')
t.test('try to lock a socket that is not a Slocket server')
t.test('delete socket between EADDRINUSE and connect')
t.test('server kill connection abruptly')
t.test('release before connection connects')
