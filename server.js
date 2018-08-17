/*
acpic - v0.0.0

Written by Federico Pereiro (fpereiro@gmail.com) and released into the public domain.

Please refer to readme.md to read the annotated source (but not yet!).
*/

var CONFIG = require ('./config.js');
var SECRET = require ('./secret.js');
var PROD   = process.argv [2] === 'prod';

var crypto = require ('crypto');
var fs     = require ('fs');
var os     = require ('os');
var Path   = require ('path');
var stream = require ('stream');
var spawn  = require ('child_process').spawn;
Error.stackTraceLimit = Infinity;

var dale   = require ('dale');
var teishi = require ('teishi');
var lith   = require ('lith');
var cicek  = require ('cicek');
var redis  = require ('redis').createClient ({db: CONFIG.redisdb});
var giz    = require ('giz');
var hitit  = require ('hitit');
var a      = require ('./astack.js');
giz.redis  = redis;

var bcrypt = require ('bcryptjs');
var mailer = require ('nodemailer').createTransport (require ('nodemailer-ses-transport') (SECRET.ses));

var sendmail = function (o, cb) {
   mailer.sendMail ({
      from: o.from1 + ' <' + o.from2 + '>',
      to: o.to1 + ' <' + o.to2 + '>',
      replyTo: o.from2,
      subject: o.subject,
      html: lith.g (o.message),
   }, function (error, rs) {
      if (error) log ('mailer error', error, o);
      else       log ('mailer message sent', o);
      if (cb) cb (error);
   });
}

redis.keyscan = function (match, cb, cursor, keys) {
   if (! cursor) cursor = 0;
   if (! keys)   keys   = {};
   redis.scan (cursor, 'MATCH', match, function (error, result) {
      if (error) return cb (error);
      cursor = result [0];
      dale.do (result [1], function (key) {
         keys [key] = true;
      });
      if (cursor !== '0') return redis.keyscan (match, cb, cursor, keys);
      cb (null, dale.keys (keys));
   });
}

redis.log = function () {
   var body;
   if (arguments.length > 1) body = [].slice.call (arguments, 0);
   else body = arguments [0];
   redis.llen ('logs', function (error, len) {
      if (error) return console.log ('redis error', error);
      var multi = redis.multi ();
      multi.lpush ('logs', teishi.complex (body) ? JSON.stringify (body) : body);
      multi.ltrim ('logs', 0, 10000);
      multi.exec (function (error) {
         if (error) return console.log ('redis error', error);
      });
   });
}

var Redis  = function (s, action) {
   redis [action].apply (redis, [].slice.call (arguments, 2).concat (function (error, data) {
      s.do (data, error);
   }));
}

var aws     = require ('aws-sdk');
var hash    = require ('murmurhash').v3;
var mime    = require ('mime');
var uuid    = require ('uuid/v4');

var s3 = new aws.S3 ({
   apiVersion: '2006-03-01',
   sslEnabled: true,
   params: {
      Bucket: SECRET.s3.bucketName,
   },
   region: SECRET.s3.region,
   credentials: {
      accessKeyId:     SECRET.s3.accessKeyId,
      secretAccessKey: SECRET.s3.secretAccessKey
   }
});

var type = teishi.t, log = teishi.l, reply = cicek.reply, stop = function (rs, rules) {
   return teishi.stop (rules, function (error) {
      reply (rs, 400, {error: error});
   });
}, hashs = function (string) {
   return hash (string) + '';
}

// *** KABOOT ***

var k      = function (s) {

   var output = {out: '', err: ''};

   var command = [].slice.call (arguments, 1);
   if (s.verbose) redis.log ('k executing command', command);
   var proc = spawn (command [0], command.slice (1));

   var wait = 3;

   var done = function () {
      if (--wait > 0) return;
      if (output.err !== '' || output.code !== 0) s.do (null, output);
      else s.do (output);
   }

   dale.do (['stdout', 'stderr'], function (v) {
      proc [v].on ('data', function (chunk) {
         output [v.replace ('std', '')] += chunk;
      });
      proc [v].on ('end', done);
   });

   proc.on ('error', function (error) {
      output.err += error + ' ' + error.stack;
      done ();
   });
   proc.on ('exit',  function (code, signal) {output.code = code; output.signal = signal; done ()});
}

// *** MAIN VIEW ***

// *** HELPERS ***

var H = {};

H.mkdirif = function (s, path) {
   a.stop (s, [k, 'test', '-d', path], {catch: function (s) {
      return [k, 'mkdir', path];
   }});
}

H.size = function (s, path) {
   if (s.size) return s.do ();
   return [
      [k, 'identify', path],
      [a.set, 'size', function (s) {
         if (! s.last || type (s.last.out) !== 'string') return s.do (null, 'Invalid imagemagick output #1: ' + path);
         var info = s.last.out.split (' ') [2];
         if (! info) return s.do (null, 'Invalid imagemagick output #2: ' + path);
         info = info.split ('x');
         if (info.length !== 2) return s.do (null, 'Invalid imagemagick output #3: ' + path);
         s.do ({w: parseInt (info [0]), h: parseInt (info [1])});
      }]
   ];
}

H.resizeIf = function (s, path, Max) {
   return [
      [H.size, path],
      function (s) {
         if (s.size.w <= Max && s.size.h <= Max) return s.do ();
         s ['t' + Max] = uuid ();
         var perc = Math.round (Max / Math.max (s.size.h, s.size.w) * 100);
         return [k, 'convert', path, '-quality', 75, '-thumbnail', perc + '%', Path.join (Path.dirname (path), s ['t' + Max])];
      }
   ];
}

H.hash = function (s, path) {
   fs.readFile (path, function (error, file) {
      if (error) return s.do (null, error);
      s.do (hash (file.toString ()));
   });
}

H.s3put = function (s, user, path, key) {
   var file = fs.createReadStream (path).pipe (crypto.createCipher (CONFIG.crypto.algorithm, SECRET.crypto.password));
   file.on ('error', function (error) {
      s.do (null, error);
   });
   return [
      function (s) {
         s3.upload ({Key: hashs (user) + '/' + key, Body: file}, function (error, data) {
            if (error) return s.do (null, error);
            s.do ([
               function (s) {
                  s3.headObject ({Key: hashs (user) + '/' + key}, function (error, data) {
                     if (error) return s.do (null, error);
                     s.last = data;
                     s.do ([
                        [a.set, false, [Redis, 'hincrby', 'users:' + user, 's3:buse', data.ContentLength]],
                     ]);
                  });
               }
            ]);
         });
      }
   ];
}

H.s3get = function (user, key, cb) {
   s3.getObject ({Key: hashs (user) + '/' + key}, function (error, data) {
      if (error) return cb (error);
      data.file = crypto.createDecipher (CONFIG.crypto.algorithm, SECRET.crypto.password);
      data.file.end (data.Body);
      redis.hincrby ('users:' + user, 's3:bget', data.ContentLength, function (error) {
         cb (error, data);
      });
   });
}

H.s3del = function (user, keys, sizes, cb) {
   s3.deleteObjects ({Delete: {Objects: dale.do (keys, function (key) {return {Key: hashs (user) + '/' + key}})}}, function (error, data) {
      if (error) return cb (error);
      var multi = redis.multi ();
      dale.do (sizes, function (size) {multi.hincrby ('users:' + user, 's3:buse', - size)});
      multi.exec (function (error) {
         cb (error, data);
      });
   });
}

H.log = function (user, ev, cb) {
   ev.t = Date.now ();
   redis.lpush ('ulog:' + user, teishi.s (ev), cb || function () {});
}

// *** ROUTES ***

var routes = [

   // *** STATIC ASSETS ***

   ['get', ['lib/*', 'client.js', 'admin.js'], cicek.file],

   ['get', '/', reply, lith.g ([
      ['!DOCTYPE HTML'],
      ['html', [
         ['head', [
            ['meta', {charset: 'utf-8'}],
            ['meta', {name: 'viewport', content: 'width=device-width,initial-scale=1'}],
            ['title', 'acpic'],
            dale.do (['pure-min', 'ionicons.min'], function (v) {
               return ['link', {rel: 'stylesheet', href: 'lib/' + v + '.css'}];
            })
         ]],
         ['body', [
            dale.do (['gotoB.min'], function (v) {
               return ['script', {src: 'lib/' + v + '.js'}];
            }),
            ['script', 'var COOKIENAME = \'' + CONFIG.cookieName + '\';'],
            ['script', 'var ALLOWEDMIME = ' + JSON.stringify (CONFIG.allowedMime) + ';'],
            ['script', 'var BASETAGS = ' + JSON.stringify (['all', 'untagged']) + ';'],
            ['script', {src: 'client.js'}]
         ]]
      ]]
   ])],

   ['get', 'admin', reply, lith.g ([
      ['!DOCTYPE HTML'],
      ['html', [
         ['head', [
            ['meta', {charset: 'utf-8'}],
            ['meta', {name: 'viewport', content: 'width=device-width,initial-scale=1'}],
            ['title', 'acpic admin'],
            dale.do (['pure-min', 'ionicons.min'], function (v) {
               return ['link', {rel: 'stylesheet', href: 'lib/' + v + '.css'}];
            })
         ]],
         ['body', [
            dale.do (['gotoB.min'], function (v) {
               return ['script', {src: 'lib/' + v + '.js'}];
            }),
            ['script', 'var COOKIENAME = \'' + CONFIG.cookieName + '\';'],
            ['script', {src: 'admin.js'}]
         ]]
      ]]
   ])],

   // *** AUTH WITH COOKIES & SESSIONS ***

   ['get', 'auth/logout', function (rq, rs) {
      giz.logout (rq.data.cookie ? (rq.data.cookie [CONFIG.cookieName] || '') : '', function (error) {
         if (error) return reply (rs, 500, {error: error});
         reply (rs, 302, '', {location: '/', 'set-cookie': cicek.cookie.write (CONFIG.cookieName, false)});
      });
   }],

   ['post', 'auth/login', function (rq, rs) {

      var b = rq.body;

      if (stop (rs, [
         ['body', b, 'object'],
         ['body', b, 'string', 'each'],
         ['keys of body', dale.keys (b), ['username', 'password'], 'eachOf', teishi.test.equal],
         function () {return [
            dale.do (['username', 'password'], function (key) {
               return ['body.' + key, b [key], 'string']
            }),
         ]},
      ])) return;

      var username = b.username.toLowerCase ().replace (/\s+$/g, '');

      var login = function (username) {
         giz.login (username, b.password, function (error, session) {
            if (error || ! session) return reply (rs, 403, {error: 'auth'});

            redis.hget ('users:' + username, 'verificationPending', function (error, pending) {
               if (error)   return reply (rs, 500, {error: error});
               if (pending) return reply (rs, 403, {error: 'verify'});
               reply (rs, 200, '', {cookie: cicek.cookie.write (CONFIG.cookieName, session)});
            });
         });
      }

      if (! username.match ('@')) login (username);
      else redis.hget ('emails', username, function (error, username) {
         if (error)      return reply (rs, 500, {error: error});
         if (! username) return reply (rs, 403, {error: 'auth'});
         login (username);
      });
   }],

   ['post', 'auth/signup', function (rq, rs) {

      var b = rq.body;

      if (stop (rs, [
         ['body', b, 'object'],
         ['body', b, 'string', 'each'],
         ['keys of body', dale.keys (b), ['username', 'password', 'email', 'token'], 'eachOf', teishi.test.equal],
         function () {return [
            dale.do (['username', 'password', 'email', 'token'], function (key) {
               return ['body.' + key, b [key], 'string']
            }),
         ]},
         function () {return [
            ['body.username', b.username, /^[^@]+$/, teishi.test.match],
            ['body.email',    b.email,    /^(([a-zA-Z0-9_\.\-]+)@([\da-zA-Z\.\-]+)\.([a-zA-Z\.]{2,6})\s*)$/, teishi.test.match],
            ['body.username length', b.username.length, {min: 3}, teishi.test.range],
            ['body.password length', b.password.length, {min: 6}, teishi.test.range],
         ]},
      ])) return;

      var username = b.username.toLowerCase ().replace (/\s+$/g, '');
      var email    = b.email.toLowerCase ().replace (/\s+$/g, '');

      var multi = redis.multi ();
      multi.hget ('invites', email);
      multi.hget ('emails', email);
      multi.exists ('users:' + username);
      multi.exec (function (error, data) {
         if (error) return reply (rs, 500, {error: error});
         var invite = teishi.p (data [0]);
         if (! invite || invite.token !== b.token) return reply (rs, 403, {error: 'token'});
         if (data [1]) return reply (rs, 403, {error: 'email'});
         if (data [2]) return reply (rs, 403, {error: 'username'});

         bcrypt.genSalt (20, function (error, vtoken) {
            if (error) return reply (rs, 500, {error: error});

            giz.signup (username, b.password, function (error) {
               if (error) return reply (rs, 500, {error: error});

               var multi2 = redis.multi ();
               multi2.hset ('verify', vtoken, email);
               multi2.hset ('invites', b.email, JSON.stringify ({token: invite.token, sent: invite.sent, accepted: Date.now ()}));

               multi2.hset ('emails', email, username);

               multi2.hmset ('users:' + username, {username: username, email: email, type: 'tier1', created: Date.now (), verificationPending: true});
               multi2.exec (function (error) {
                  if (error)  return reply (rs, 500, {error: error});
                  if (! PROD) return reply (rs, 200, {token: vtoken});
                  // XXX SEND EMAIL if PROD
               });
            });
         });
      });
   }],

   ['get', 'auth/verify/(*)', function (rq, rs) {

      var token = rq.data.params [0];

      redis.hget ('verify', token, function (error, email) {
         if (error) return reply (rs, 500, {error: error});
         if (! email) return reply (rs, 403, {});
         redis.hget ('emails', email, function (error, username) {
            if (error) return reply (rs, 500, {error: error});
            var multi = redis.multi ();
            multi.hdel ('users:' + username, 'verificationPending');
            multi.hdel ('verify', token);
            multi.exec (function (error) {
               if (error) return reply (rs, 500, {error: error});
               reply (rs, 302, '', {location: '/'});
            });
         });
      });
   }],

   // *** PASSWORD RECOVER/RESET ***

   ['post', 'auth/recover', function (rq, rs) {
      if (type (rq.body) !== 'object') return reply (rs, 400);
      if (type (rq.body.username) !== 'string') return reply (rs, 400);

      // XXX remove whitespace
      giz.recover (rq.body.username.toLowerCase (), function (error, token) {
         if (error) return reply (rs, 403);
         redis.hgetall ('users:' + rq.body.username.toLowerCase (), function (error, user) {
            if (error) return reply (rs, 500);
            H.resolveTemplate ('password recovery', {firstName: rq.body.username.toLowerCase (), link: 'https://' + CONFIG.server + '#/auth/reset/' + encodeURIComponent (rq.body.username.toLowerCase ()) + '/' + encodeURIComponent (token)}, function (error, template) {
               H.sendEmail ({
                  recipientName: user.username,
                  recipientEmail: user.email,
                  subject: 'Password recovery rq',
                  message: template
               }, function (error) {
                  return reply (rs, error ? 500 : 200);
               });
            });
         });
      });
   }],

   ['post', 'auth/reset', function (rq, rs) {

      // XXX remove whitespace
      var b = rq.body;

      if (type (b) !== 'object' || type (b.username) !== 'string' || type (b.token) !== 'string' || type (b.password) !== 'string' || b.password.length < 6) return reply (rs, 400);

      redis.hgetall ('users:' + b.username, function (error, user) {
         if (error) return reply (rs, 500);
         giz.reset (b.username, b.token, b.password, function (error) {
            reply (rs, error ? 403 : 200, error ? {error: 'token'} : '');
            if (! error) H.resolveTemplate ('password change', {firstName: b.username.toLowerCase ()}, function (error, template) {
               H.sendEmail ({
                  recipientName: user.username,
                  recipientEmail: user.email,
                  subject: 'Password changed',
                  message: template
               });
            });
         });
      });
   }],

   // *** GATEKEEPER FUNCTION ***

   ['all', '*', function (rq, rs) {

      if (! PROD && rq.url === '/admin/invites') return rs.next ();

      var session = rq.data.cookie ? (rq.data.cookie [CONFIG.cookieName] || '') : '';
      giz.auth (session, function (error, user) {
         if (error || ! user) {
            var cookie = {'set-cookie': cicek.cookie.write (CONFIG.cookieName, false)};
            if (rq.method === 'get' && rq.url === '/') reply (rs, 200, view, cookie, 'html');
            else                                                 reply (rs, 403, {error: 'Invalid session.'});
         }
         else {
            rs.log.user = user.username;
            rq.user = user;
            rs.next ();
         }
      });
   }],

   // *** DELETE ACCOUNT ***

   ['post', 'auth/delete', function (rq, rs) {

      if (PROD) return reply (rs, 501);

      giz.destroy (rq.user.username, function (error) {
         if (error) return reply (rs, 500, error);
         var multi = redis.multi ();
         multi.hdel ('emails',  rq.user.email);
         multi.hdel ('invites', rq.user.email);
         multi.del ('tags:' + rq.user.username);
         multi.del ('ulog:' + rq.user.username);
         multi.del ('shm:'  + rq.user.username);
         multi.del ('sho:'  + rq.user.username);
         multi.exec (function (error) {
            if (error) return reply (rs, 500, error);
            giz.logout (rq.data.cookie [CONFIG.cookieName], function (error) {
               H.log (rq.user.username, {a: 'des'});
               reply (rs, 302, '', {location: '/', 'set-cookie': cicek.cookie.write (CONFIG.cookieName, false)});
            });
         });
      });
   }],

   // *** DOWNLOAD PICS ***

   ['get', 'pic/:id', function (rq, rs) {
      redis.hgetall ('pic:' + rq.data.params.id, function (error, pic) {
         if (error)        return reply (rs, 500, error);
         if (pic === null) return reply (rs, 404);
         if (rq.user.username === pic.owner) return cicek.file (rq, rs, Path.join (hashs (pic.owner), pic.id), [CONFIG.picfolder]);
         redis.smembers ('pict:' + pic.id, function (error, tags) {
            if (error) return reply (rs, 500, error);
            if (tags.length === 0) return reply (rs, 404);
            var multi = redis.multi ();
            dale.do (tags, function (tag) {
               multi.sismember ('shm:' + rq.user.username, pic.owner + ':' + tag);
            });
            multi.exec (function (error, data) {
               if (error) return reply (rs, 500, error);
               if (! dale.stop (data, true, function (v) {
                  if (! v) return;
                  redis.hincrby ('pic:' + pic.id, 'xp', 1);
                  cicek.file (rq, rs, Path.join (hashs (pic.owner), pic.id), [CONFIG.picfolder]);
                  return true;
               })) reply (rs, 404);
            });
         });
      });
   }],

   ['get', 'thumb/:id', function (rq, rs) {
      redis.get ('thu:' + rq.data.params.id, function (error, pic) {
         if (error)        return reply (rs, 500, error);
         if (pic === null) return reply (rs, 404);
         redis.hgetall ('pic:' + pic, function (error, pic) {
            if (error)        return reply (rs, 500, error);
            if (pic === null) return reply (rs, 404);
            if (rq.user.username === pic.owner) return cicek.file (rq, rs, Path.join (hashs (pic.owner), rq.data.params.id), [CONFIG.picfolder]);
            redis.smembers ('pict:' + pic.id, function (error, tags) {
               if (error) return reply (rs, 500, error);
               if (tags.length === 0) return reply (rs, 404);
               var multi = redis.multi ();
               dale.do (tags, function (tag) {
                  multi.sismember ('shm:' + rq.user.username, pic.owner + ':' + tag);
               });
               multi.exec (function (error, data) {
                  if (error) return reply (rs, 500, error);
                  if (! dale.stop (data, true, function (v) {
                     if (! v) return;
                     redis.hincrby ('pic:' + pic.id, 'xt' + (rq.data.params.id === pic.t200 ? 2 : 9), 1);
                     cicek.file (rq, rs, Path.join (hashs (pic.owner), rq.data.params.id), [CONFIG.picfolder]);
                     return true;
                  })) reply (rs, 404);
               });
            });
         });
      });
   }],

   // *** UPLOAD PICTURES ***

   ['post', 'pic', function (rq, rs) {

      if (! rq.data.fields) return reply (rs, 400, {error: 'No fields present.'});
      if (! rq.data.files)  return reply (rs, 400, {error: 'No files present.'});
      if (! teishi.eq (dale.keys (rq.data.fields), ['lastModified'])) return reply (rs, 400, {error: 'Invalid data field.'});
      if (! teishi.eq (dale.keys (rq.data.files), ['pic'])) return reply (rs, 400, {error: 'Invalid file field.'});

      if (type (parseInt (rq.data.fields.lastModified)) !== 'integer') return reply (rs, 400, {error: 'No valid lastModified field present.'});
      if (! rq.data.files.pic) return reply (rs, 400, {error: 'No pic present.'});

      if (CONFIG.allowedMime.indexOf (mime.lookup (rq.data.files.pic)) === -1) return reply (rs, 400, 'Invalid pic.');

      var path = rq.data.files.pic;

      a.stop (function (s) {
         var pic = {lastModified: parseInt (rq.data.fields.lastModified)};
         pic.id     = uuid ();
         pic.owner  = rq.user.username;
         pic.name   = path.slice (path.indexOf ('_') + 1);
         pic.dateup = new Date ().getTime ();

         var newpath = Path.join (CONFIG.picfolder, hashs (rq.user.username), pic.id);

         return [{verbose: true}, [
            [a.set, 'hash', [H.hash, path]],
            function (s) {
               return [Redis, 'sismember', 'upic:' + rq.user.username, s.hash];
            },
            function (s) {
               if (s.last) return reply (rs, 409);
               return [
                  [Redis, 'hget', 'users:' + rq.user.username, 's3:buse'],
                  function (s) {
                     if (s.last !== null && CONFIG.storelimit [rq.user.tier || 'tier1'] < parseInt (s.last)) return reply (rs, 409, 'Storage limit exceeded.');
                     s.do ();
                  },
                  [H.mkdirif, Path.dirname (newpath)],
                  [k, 'cp', path, newpath],
                  [a.set, 'metadata', [k, 'identify', '-format', "'%[*]'", path]],
                  [a.make (fs.unlink), path],
                  [H.resizeIf, newpath, 200],
                  [H.resizeIf, newpath, 900],
                  function (s) {
                     if (! s.metadata || ! s.metadata.out) return s.do (null, 'Metadata retrieval failed.');
                     var metadata = s.metadata.out.split ('\n');
                     s.dates = dale.obj (metadata, function (line) {
                        if (line.match (/date/i)) return [line.split ('=') [0], line.split ('=') [1]];
                     });
                     s.orientation = dale.fil (metadata, undefined, function (line) {
                        if (line.match (/orientation/i)) return line;
                     });
                     s.do ();
                  },
                  function (s) {
                     return [
                        [a.set, 'picdata', [H.s3put, rq.user.username, newpath, pic.id]],
                        ! s.t200 ? [] : [
                           [a.set, 't200data', [H.s3put, rq.user.username, Path.join (Path.dirname (newpath), s.t200), s.t200]],
                        ],
                        ! s.t900 ? [] : [
                           [a.set, 't900data', [H.s3put, rq.user.username, Path.join (Path.dirname (newpath), s.t900), s.t900]],
                        ]
                     ];
                  },
                  function (s) {
                     var multi = redis.multi ();

                     pic.dimw = s.size.w;
                     pic.dimh = s.size.h;

                     pic.by   = s.picdata.ContentLength;
                     pic.hash = s.hash;

                     s.dates ['upload:date'] = pic.lastModified;
                     delete pic.lastModified;
                     pic.dates = JSON.stringify (s.dates);
                     if (s.orientation.length > 0) pic.orientation = JSON.stringify (s.orientation);

                     pic.date = dale.fil (s.dates, undefined, function (v) {
                        if (! v) return;
                        var d = new Date (v);
                        if (d.getTime ()) return d.getTime ();
                        d = new Date (v.replace (':', '-').replace (':', '-'));
                        if (d.getTime ()) return d.getTime ();
                     }).sort (function (a, b) {
                        return a - b;
                     });
                     pic.date = pic.date [0];

                     if (s.t200) {
                        pic.t200 = s.t200;
                        pic.by200 = s.t200data.ContentLength;
                        multi.set ('thu:' + pic.t200, pic.id);
                     }
                     if (s.t900) {
                        pic.t900 = s.t900;
                        pic.by900 = s.t900data.ContentLength;
                        multi.set ('thu:' + pic.t900, pic.id);
                     }

                     multi.sadd ('upic:' + rq.user.username, pic.hash);
                     multi.sadd ('tag:'  + rq.user.username  + ':all',      pic.id);
                     multi.sadd ('tag:'  + rq.user.username  + ':untagged', pic.id);
                     multi.hincrby ('tags:' + rq.user.username, 'untagged', 1);
                     multi.hmset ('pic:' + pic.id, pic);
                     multi.exec (function (error) {
                        if (error) return reply (rs, 500, error);
                        if (! rs.connection.writable) {
                           redis.log (['error', 'client upload error', {pic: s.pic}]);
                           cicek.log (['error', 'client upload error', {pic: s.pic}]);
                           return;
                        }
                        H.log (rq.user.username, {a: 'upl', id: pic.id});
                        reply (rs, 200, pic);
                     });
                  }
               ];
            }
         ]];
      }, {catch: function (s) {
         reply (rs, 500, s.catch);
      }});
   }],

   // *** DELETE PICS ***

   ['delete', 'pic/:id', function (rq, rs) {

      var id = rq.data.params.id;

      a.stop ([
         [function (s) {
            var multi = redis.multi ();
            multi.hgetall ('pic:'  + id);
            multi.smembers ('pict:' + id);
            multi.exec (function (error, data) {
               if (error) return reply (rs, 500, {error: 'Redis error 1'});
               s.last = data;
               s.do ();
            });
         }],
         function (s) {
            s.pic = s.last [0];
            s.tags = s.last [1];
            if (! s.pic || rq.user.username !== s.pic.owner) return reply (rs, 404);

            var toDelete = [s.pic.id], toDeleteSizes = [s.pic.by];
            if (s.pic.t200) {
               toDelete.push (s.pic.t200);
               toDeleteSizes.push (s.pic.by900);
            }
            if (s.pic.t900) {
               toDelete.push (s.pic.t900);
               toDeleteSizes.push (s.pic.by900);
            }

            H.s3del (rq.user.username, toDelete, toDeleteSizes, function (error) {
               if (error) return s.do (null, error);
               a.fork (s, toDelete, function (v) {
                  return [a.make (fs.unlink), Path.join (CONFIG.picfolder, hashs (rq.user.username), v)];
               });
            });
         },
         function (s) {
            var multi = redis.multi ();

            multi.del  ('pic:'  + s.pic.id);
            multi.del  ('pict:' + s.pic.id);
            if (s.pic.t200) multi.del ('thu:' + s.pic.t200);
            if (s.pic.t900) multi.del ('thu:' + s.pic.t900);
            multi.srem ('upic:' + s.pic.owner, s.pic.hash);

            if (s.tags.length === 0) multi.hincrby ('tags:' + s.pic.owner, 'untagged', -1);

            s.tags = s.tags.concat (['all', 'untagged']);

            dale.do (s.tags, function (tag) {
               if (tag !== 'all' && tag !== 'untagged') multi.hincrby ('tags:' + s.pic.owner, tag, -1);
               multi.srem ('tag:' + s.pic.owner + ':' + tag, s.pic.id);
            });

            multi.exec (function (error) {
               if (error) return s.do (null, error);
               H.log (rq.user.username, {a: 'del', id: s.pic.id});
               reply (rs, 200);
            });
         },
      ], {catch: function (s) {
         reply (rs, 500, s.catch);
      }});
   }],

   // *** ROTATE IMAGE ***

   ['post', 'rotate', cicek.json (function (rq, rs) {

      var b = rq.body;

      if (type (b) !== 'object')    return reply (rs, 400, {error: 'body must be an object.'});
      if (type (b.id) !== 'string') return reply (rs, 400, {error: 'body.id must be a string.'});
      if ([90, 180, -90].indexOf (b.deg) === -1) return reply (rs, 400, {error: 'body.deg must be 90, 180 or -90.'});

      var path, tmppath;

      a.stop ([{verbose: true}, [
         [a.set, 'pic', [Redis, 'hgetall', 'pic:' + b.id]],
         function (s) {
            if (! s.pic || s.pic.owner !== rq.user.username) return reply (rs, 404);
            path    = Path.join (CONFIG.picfolder, hashs (s.pic.owner), s.pic.id);
            tmppath = Path.join (os.tmpdir (), s.pic.id);
            s.do ([
               [k, 'cp', path, tmppath],
               [k, 'mogrify', '-rotate', b.deg, tmppath],
               [k, 'cp', tmppath, path],
               [a.make (fs.unlink), tmppath],
               [a.make (H.s3del), rq.user.username, b.id, s.pic.by],
               [a.set, 'picdata', [H.s3put, rq.user.username, path, b.id]],
               [H.resizeIf, path, 200],
               [H.resizeIf, path, 900],
               function (s) {return [
                  ! s.t200 ? [] : [a.set, 't200data', [H.s3put, rq.user.username, path, s.t200]],
                  ! s.t900 ? [] : [a.set, 't900data', [H.s3put, rq.user.username, path, s.t900]],
               ]},
            ]);
         },
         function (s) {
            var toDelete = dale.fil (['t200', 't900'], undefined, function (t) {
               return s.pic [t];
            });
            var toDeleteSizes = dale.fil (['by200', 'by900'], undefined, function (t) {
               return s.pic [t];
            });
            if (toDelete.length === 0) return s.do ();
            return [
               dale.do (toDelete, function (t) {
                  return [a.make (fs.unlink), Path.join (CONFIG.picfolder, hashs (rq.user.username), t)];
               }),
               [a.make (H.s3del), rq.user.username, toDelete, toDeleteSizes]
            ];
         },
         function (s) {
            var multi = redis.multi ();
            if (s.pic.t200) {
               multi.hdel ('pic:' + s.pic.id, 't200', 'by200');
               multi.del ('thu:' + s.pic.t200);
            }
            if (s.pic.t900) {
               multi.hdel ('pic:' + s.pic.id, 't900', 'by900');
               multi.del ('thu:' + s.pic.t900);
            }
            var update = {dimh: s.size.h, dimw: s.size.w, by: s.picdata.ContentLength};
            if (s.t200) {
               update.t200  = s.t200;
               update.by200 = s.t200data.ContentLength;
               multi.set ('thu:' + update.t200, s.pic.id);
            }
            if (s.t900) {
               update.t900  = s.t900;
               update.by900 = s.t900data.ContentLength;
               multi.set ('thu:' + update.t900, s.pic.id);
            }
            multi.hmset ('pic:' + s.pic.id, update);
            multi.exec (function (error) {
               if (error) return s.do (null, error);
               H.log (rq.user.username, {a: 'rot', id: b.id, d: b.deg, o: s.pic.orientation});
               reply (rs, 200);
            });
         },
      ]], {catch: function (s) {
         return reply (rs, 500, s.catch);
      }});

   })],

   // *** TAGGING ***

   ['post', 'tag', cicek.json (function (rq, rs) {
      var b = rq.body;
      if (type (b)     !== 'object') return reply (rs, 400, {error: 'body must be an object.'});
      if (type (b.tag) !== 'string') return reply (rs, 400, {error: 'body.tag must be a string.'});

      b.tag = b.tag.replace (/^\s+|\s+$/g, '');

      if (b.tag.match (/^\d{4}$/) && parseInt (b.tag) > 1899 && parseInt (b.tag) < 2101) return reply (rs, 400, {error: 'Tag cannot be a number between 1900 and 2100.'});

      if (type (b.ids) !== 'array') return reply (rs, 400, {error: 'Invalid pics.'});
      if (stop (rs, [
         ['body.tag', b.tag, 'all',      teishi.test.notEqual],
         ['body.tag', b.tag, 'untagged', teishi.test.notEqual],
         ['body.ids', b.ids, 'array'],
         ['body.ids', b.ids, 'string', 'each'],
         ['body.ids', b.del, ['boolean', 'undefined'], 'oneOf'],
      ])) return;

      a.stop ([
         [function (s) {
            var multi = redis.multi ();
            dale.do (b.ids, function (id) {
               multi.hget  ('pic:'  + id, 'owner');
               multi.smembers ('pict:' + id);
            });
            multi.exec (function (error, data) {
               if (error) return reply (rs, 500, error);
               // XXX s.do (data) doesn't work!
               s.last = data;
               s.do ();
            });
         }],
         function (s) {
            var multi = redis.multi ();
            var seen = {};
            dale.do (s.last, function (v, k) {
               if (k % 2 !== 0) return;
               var pic = b.ids [k / 2];
               if (seen [pic]) return;
               else seen [pic] = true;
               if (v === null || v !== rq.user.username) return;
               if (b.del) {
                  if (s.last [k + 1].indexOf (b.tag) === -1) return;
                  multi.srem    ('pict:' + pic, b.tag);
                  multi.hincrby ('tags:' + rq.user.username, b.tag, -1);
                  multi.srem ('tag:'   + rq.user.username + ':' + b.tag, pic);
                  if (s.last [k + 1].length === 1) {
                     multi.hincrby ('tags:' + rq.user.username, 'untagged', 1);
                     multi.sadd    ('tag:'  + rq.user.username + ':untagged', pic);
                  }
               }
               else {
                  if (s.last [k + 1].indexOf (b.tag) !== -1) return;
                  multi.sadd    ('pict:' + pic, b.tag);
                  multi.hincrby ('tags:' + rq.user.username, b.tag, 1);
                  multi.sadd ('tag:'   + rq.user.username + ':' + b.tag, pic);
                  if (s.last [k + 1].length === 0) {
                     multi.hincrby ('tags:' + rq.user.username, 'untagged', -1);
                     multi.srem    ('tag:'  + rq.user.username + ':untagged', pic);
                  }
               }
            });
            multi.exec (function (error) {
               if (error) return reply (rs, 500, error);
               reply (rs, 200);
               H.log (rq.user.username, {a: 'tag', tag: b.tag, d: b.del ? true : undefined, ids: b.ids});
            })
         }
      ], {catch: function (s) {
         return reply (rs, 500, s.catch);
      }});
   })],

   ['get', 'tags', function (rq, rs) {
      var multi = redis.multi ();
      multi.hgetall ('tags:' + rq.user.username);
      multi.scard   ('tag:'  + rq.user.username + ':all');
      multi.exec (function (error, data) {
         if (error) return reply (rs, 500, error);
         var output = {all: parseInt (data [1])};
         reply (rs, 200, dale.obj (data [0], output, function (v, k) {
            v = parseInt (v);
            if (v > 0) return [k, v];
         }));
      });
   }],

   // *** SEARCH ***

   ['post', 'query', cicek.json (function (rq, rs) {

      var b = rq.body;

      if (stop (rs, [
         ['body', b, 'object'],
         function () {return [
            ['body.tags', b.tags, 'array'],
            ['body.tags', b.tags, 'string', 'each'],
            ['body.mindate',  b.mindate,  ['undefined', 'integer'], 'oneOf'],
            ['body.maxdate',  b.maxdate,  ['undefined', 'integer'], 'oneOf'],
            ['body.from',  b.from, 'integer'],
            ['body.to',    b.to,   'integer'],
            ['body.from',  b.from, {min: 1},      teishi.test.range],
            ['body.to',    b.to,   {min: b.from}, teishi.test.range],
            ['body.sort', b.sort, ['newest', 'oldest', 'upload'], 'oneOf', teishi.test.equal],
         ]}
      ])) return;

      if (b.tags.indexOf ('all') !== -1) return reply (rs, 400, {error: '`all` is not a valid tag. Please send an empty tag array instead'});

      var yeartags = [], mindate, maxdate;

      var tags = dale.obj (b.tags, function (tag) {
         if (tag.match (/^\d{4}$/) && 2100 >= parseInt (tag) && parseInt (tag) >= 1900) yeartags.push (tag);
         else return [tag, [rq.user.username]];
      });

      if (yeartags.length > 0) {
         if (b.mindate !== undefined || b.maxdate !== undefined) return reply (rs, 400, {error: 'You cannot pass mindate/maxdate if you send tags between 1900 and 2100'});
         yeartags.sort ();
         yeartags = dale.do (yeartags, function (year) {
            return [new Date (year + '/01/01').getTime (), new Date ((parseInt (year) + 1) + '/01/01').getTime () - 1];
         });
      }
      else {
         mindate = b.mindate || 0;
         maxdate = b.maxdate || new Date ('2101/01/01');
      }

      redis.smembers ('shm:' + rq.user.username, function (error, shared) {
         if (error) return reply (rs, 500, error);

         var allmode = dale.keys (tags).length === 0;

         if (allmode) tags.all = [rq.user.username];

         dale.do (shared, function (sharedTag) {
            var tag = sharedTag.replace (/[^:]+:/, '');
            if (allmode || tags [tag]) {
               if (! tags [tag]) tags [tag] = [];
               tags [tag].push (sharedTag.match (/[^:]+/) [0]);
            }
         });

         // for each tag (or all tags if all is there) list usres per tag that share it with you. run a sunion per tag, also including your own username. then do a sinter of the whole thing.

         var multi = redis.multi (), qid = 'query:' + uuid ();
         dale.do (tags, function (users, tag) {
            multi.sunionstore (qid + ':' + tag, dale.do (users, function (user) {
               return 'tag:' + user + ':' + tag;
            }));
         });
         multi [allmode ? 'sunion' : 'sinter'] (dale.do (tags, function (users, tag) {
            return qid + ':' + tag;
         }));
         dale.do (tags, function (users, tag) {
            multi.del (qid + ':' + tag);
         });

         multi.exec (function (error, data) {
            if (error) return reply (rs, 500, error);
            var pics = data [dale.keys (tags).length];
            var multi2 = redis.multi ();
            dale.do (pics, function (pic) {
               multi2.hgetall ('pic:' + pic);
            });
            multi2.exec (function (error, pics) {
               if (error) return reply (rs, 500, error);
               var output = {total: pics.length, pics: []};

               dale.do (pics, function (pic) {
                  var d = parseInt (pic [b.sort === 'upload' ? 'dateup': 'date']);
                  if (yeartags.length > 0) {
                     if (dale.stop (yeartags, true, function (year) {
                        if (d >= year [0] && d <= year [1]) return true;
                     })) output.pics.push (pic);
                     return;
                  }
                  if (d >= mindate && d <= maxdate) output.pics.push (pic);
               });

               output.pics.sort (function (a, b) {
                  if (a.owner === rq.user.username) return -1;
                  if (b.owner === rq.user.username) return 1;
                  return (a.owner < b.owner ? -1 : (a.owner > b.owner ? 1 : 0));
               });

               var hashes = {};
               output.pics = dale.fil (output.pics, undefined, function (pic, k) {
                  if (! hashes [pic.hash]) {
                     hashes [pic.hash] = true;
                     return pic;
                  }
                  else output.total--;
               });

               output.pics.sort (function (a, B) {
                  var d1 = parseInt (a [b.sort === 'upload' ? 'dateup' : 'date']);
                  var d2 = parseInt (B [b.sort === 'upload' ? 'dateup' : 'date']);
                  return b.sort === 'oldest' ? d1 - d2 : d2 - d1;
               });

               output.pics = output.pics.slice (b.from - 1, b.to);

               var multi3 = redis.multi ();
               dale.do (output.pics, function (pic) {
                  multi3.smembers ('pict:' + pic.id);
               });
               multi3.exec (function (error, tags) {
                  if (error) return reply (rs, 500, error);
                  dale.do (output.pics, function (pic, k) {
                     pic.tags = tags [k];
                     pic.date = parseInt (pic.date);
                     pic.dateup = parseInt (pic.dateup);
                     pic.dimh   = parseInt (pic.dimh);
                     pic.dimw   = parseInt (pic.dimw);
                     pic.hash  = undefined;
                     pic.by    = undefined;
                     pic.by200 = undefined;
                     pic.by900 = undefined;
                     pic.dates = undefined;
                     pic.orientation = undefined;
                     pic.hitt = undefined;
                     pic.hit2 = undefined;
                     pic.hit9 = undefined;
                  });
                  reply (rs, 200, output);
               });
            });
         });
      });
   })],

   // *** SHARING ***

   ['post', 'share', cicek.json (function (rq, rs) {

      var b = rq.body;

      if (stop (rs, [
         ['body', b, 'object'],
         function () {return [
            ['body.tag', b.tag, 'string'],
            ['body.who', b.who, 'string'],
            ['body.del', b.del, ['boolean', 'undefined'], 'oneOf']
         ]}
      ])) return;

      if (b.tag === 'all' || b.tag === 'untagged') return reply (rs, 400, {error: 'You cannot share that tag.'});

      redis.exists ('users:' + b.who, function (error, exists) {
         if (error) return reply (rs, 500, error);
         if (! exists) return reply (rs, 404);

         var multi = redis.multi ();

         multi [b.del ? 'srem' : 'sadd'] ('sho:' + rq.user.username, b.who           + ':' + b.tag);
         multi [b.del ? 'srem' : 'sadd'] ('shm:' + b.who,           rq.user.username + ':' + b.tag);
         multi.exec (function (error) {
            reply (rs, error ? 500 : 200, error || '');
         });
      });
   })],

   ['get', 'share', function (rq, rs) {
      var multi = redis.multi ();
      multi.smembers ('sho:' + rq.user.username);
      multi.smembers ('shm:' + rq.user.username);
      multi.exec (function (error, data) {
         var output = {
         };
         reply (rs, error ? 500 : 200, error || {
            sho: dale.do (data [0], function (i) {
               return [i.split (':') [0], i.split (':').slice (1).join (':')];
            }),
            shm: dale.do (data [1], function (i) {
               return [i.split (':') [0], i.split (':').slice (1).join (':')];
            }),
         });
      });
   }],

   // *** CLIENT ERRORS ***

   ['post', 'api/clienterror', cicek.json (function (rq, rs) {
      if (PROD) fs.appendFile ('clienterror.log', teishi.s ({date: new Date ().toUTCString (), headers: rq.headers, user: (rq.user || {}).id, error: rq.body}) + '\n');
      reply (rs, 200);
   })],

   // *** ADMIN GATEKEEPER ***

   ['all', '*', function (rq, rs) {
      if (! PROD) return rs.next ();

      if (SECRET.admins.indexOf (rq.user.email) === -1) return reply (rs, 403);
      rs.next ();
   }],

   // *** INVITES ***

   ['post', 'admin/invites', function (rq, rs) {

      var b = rq.body;

      if (stop (rs, [
         ['body', b, 'object'],
         ['body', b, 'string', 'each'],
         ['keys of body', dale.keys (b), ['email'], 'eachOf', teishi.test.equal],
         function () {return [
            ['body.email', b.email, /^(([a-zA-Z0-9_\.\-]+)@([\da-zA-Z\.\-]+)\.([a-zA-Z\.]{2,6})\s*)$/, teishi.test.match],
         ]},
      ])) return;

      var email = b.email.toLowerCase ().replace (/\s+$/g, '');

      bcrypt.genSalt (20, function (error, itoken) {
         if (error) return reply (rs, 500, {error: error});
         redis.hset ('invites', email, JSON.stringify ({token: itoken, sent: Date.now ()}), function (error) {
            if (error) return reply (rs, 500, {error: error});
            if (! PROD) return reply (rs, 200, {token: itoken});
            // XXX SEND EMAIL if PROD
         });
      });
   }],

   // *** LOGS ***

   ['post', 'logs', cicek.json (function (rq, rs) {
      redis.lrange ('logs', 0, -1, function (error, list) {
         if (error) return reply (rs, 500, error);
         reply (rs, 200, dale.fil (list, undefined, function (v) {
            if (! rq.body.query || v.match (new RegExp (rq.body.query.replace (/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i'))) return v;
         }).slice (0, 50));
      });
   })],

];

// *** LAUNCH SERVER ***

if (PROD) {
   cicek.options.log.file.path = CONFIG.accesslog;
   cicek.options.log.console   = false;
}
cicek.options.cookieSecret = SECRET.cookie;
cicek.options.log.body = function (log) {
   if (log.requestqBody && log.requestBody.password) return false;
   return true;
}

cicek.apres = function (rs) {
   if (rs.log.url.match (/^\/logs/)) rs.log.responseBody = 'OMITTED';
   if (rs.log.url.match (/^\/auth/)) {
      if (rs.log.requestBody && rs.log.requestBody.password) rs.log.requestBody.password = 'OMITTED';
   }
   if (CONFIG.errorlog && PROD && rs.log.code > 399 && rs.log.code !== 409) fs.appendFile (CONFIG.errorlog, teishi.s (rs.log));
   cicek.Apres (rs);
}

cicek.cluster ();

cicek.listen ({port:  CONFIG.port}, routes);
