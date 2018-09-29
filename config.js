var DOMAIN = {
   dev:  'https://altocode.nl:1427/',
   prod: 'http://104.248.38.85:1427/',
} [process.argv [2]];

module.exports = {
   cookiename: 'ac-v1',
   allowedmime: ['image/jpeg', 'image/png'],
   port: 1427,
   accesslog: 'access.log',
   errorlog:  'error.log',
   clientlog: 'client.log',
   picfolder: process.argv [2] ? '/root/files' : '/home/hq/acpic/files',
   redisdb: 15,
   crypto: {
      algorithm: 'aes-256-ctr'
   },
   storelimit: {
      tier1:   12 * 1024 * 1024 * 1024,
      tier2:  100 * 1024 * 1024 * 1024,
   },
   backup: {
      frequency: 10,
      path: '/var/lib/redis/dump.rdb',
   },
   etemplates: {
      verify: {
         subject: 'Please verify your email',
         message: function (username, token) {
            return ['p', [
               'Hi ' + username,
               ['br'],
               'Welcome to acpic! Please verify your email by clicking on the following link: ',
               ['a', {href: DOMAIN + 'auth/verify/' + encodeURIComponent (token)}, 'Verify your email'],
               ['br'],
               'Have an amazing ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] [new Date ().getDay ()] + '!',
            ]];
         }
      },
      recover: {
         subject: 'Did you forget your password?',
         message: function (username, token) {
            return ['p', [
               'Hi ' + username,
               ['br'],
               'Did you forget your password? If you did, all good: please use the following link to reset your password',
               ['a', {href: DOMAIN + 'auth/reset?username=' + encodeURIComponent (username) + '&token=' + encodeURIComponent (token)}, 'Reset your password'],
               ['br'],
               'If you didn\'t request a password reset, please do NOT click the link above. Rather, please reply to this email letting us know.',
               'Have an amazing ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] [new Date ().getDay ()] + '!',
            ]];
         }
      },
      reset: {
         subject: 'You just changed your password',
         message: function (username) {
            return ['p', [
               'Hi ' + username,
               ['br'],
               'We just changed your password. If you performed this change, no further action is necessary.',
               ['br'],
               'If you didn\'t change your password, please contact us IMMEDIATELY.',
               ['br'],
               'Have an amazing ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] [new Date ().getDay ()] + '!',
            ]];
         }
      },
      invite: {
         subject: 'Your invitation to join acpic',
         message: function (username, token) {
            return ['p', [
               'Hi ' + username,
               ['br'],
               'Here\'s your invitation to join acpic! It would be great to have you as our user! ',
               ['a', {href: DOMAIN + 'auth/signup/' + encodeURIComponent (token)}, 'Join us!'],
               ['br'],
               'Have an amazing ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] [new Date ().getDay ()] + '!',
            ]];
         }
      }
   }
}

// Below is a template for creating secret.js . All UPPERCASE strings must be replaced by proper values.
/*
module.exports = {
   cookie: 'COOKIESECRET',
   s3: {
      accessKeyId:     'KEY',
      secretAccessKey: 'SECRETKEY',
      pic: {
         bucketName:      'BUCKETNAME',
         region:          'REGION',
      },
      db: {
         bucketName:      'BUCKETNAME',
         region:          'REGION',
      }
   },
   ses: {
      accessKeyId:     'KEY',
      secretAccessKey: 'SECRETKEY',
   },
   crypto: {
      password: 'CRYPTOSTRONGPASSWORD',
   },
   admins: ['EMAIL1', 'EMAIL2', ...]
}
*/
