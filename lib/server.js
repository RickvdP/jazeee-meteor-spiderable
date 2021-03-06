const child_process = Npm.require('child_process');
const querystring = Npm.require('querystring');
const urlParser = Npm.require('url');
const cacheCollection = new Mongo.Collection('SpiderableCacheCollection');

Meteor.startup(() => {
  if (Spiderable.cacheLifetimeInMinutes == null) {
    Spiderable.cacheLifetimeInMinutes = 3 * 60;
  }

  if (!_.isNumber(Spiderable.cacheLifetimeInMinutes)) {
    throw new Meteor.Error('Bad Spiderable.cacheLifetimeInMinutes');
  }

  cacheCollection._ensureIndex({
    createdAt: 1
  }, {
    expireAfterSeconds: Spiderable.cacheLifetimeInMinutes * 60,
    background: true
  });
});

cacheCollection._ensureIndex({
  hash: 1
}, {
  unique: true,
  background: true
});

const bindEnvironment = Meteor.bindEnvironment(function(callback) {
  return callback();
});

Spiderable.userAgentRegExps = [
  /^facebookExternalHit/i,
  /^linkedinBot/i,
  /^twitterBot/i,
  /^googleBot/i,
  /^bingBot/i,
  /^yandex/i,
  /^google-structured-data-testing-tool/i,
  /^yahoo/i,
  /^MJ12Bot/i,
  /^tweetmemeBot/i,
  /^baiduSpider/i,
  /^Mail\.RU_Bot/i,
  /^ahrefsBot/i,
  /^SiteLockSpider/i
];

Spiderable.allowRedirects = true;
Spiderable.ignoredRoutes = [];
Spiderable.debug = false;
const REQUEST_TIMEOUT_IN_MILLISECONDS = 30 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

Spiderable._urlForPhantom = (siteAbsoluteUrl, requestUrl) => {
  const parsedUrl = urlParser.parse(requestUrl);
  const parsedQuery = querystring.parse(parsedUrl.query);
  const escapedFragment = parsedQuery._escaped_fragment_;
  delete parsedQuery._escaped_fragment_;

  if (Spiderable.customQuery) {
    if (_.isString(Spiderable.customQuery)) {
      parsedQuery[Spiderable.customQuery] = 'true';
    } else if (_.isBoolean(Spiderable.customQuery) && Spiderable.customQuery) {
      parsedQuery.___isRunningPhantomJS___ = 'true';
    }
  }

  const parsedAbsoluteUrl = urlParser.parse(siteAbsoluteUrl);
  if (parsedUrl.pathname.charAt(0) === '/') {
    parsedUrl.pathname = parsedUrl.pathname.substring(1);
  }

  parsedAbsoluteUrl.pathname = urlParser.resolve(parsedAbsoluteUrl.pathname, parsedUrl.pathname);
  parsedAbsoluteUrl.query = parsedQuery;
  parsedAbsoluteUrl.search = null;
  if ((escapedFragment != null) && escapedFragment.length > 0) {
    parsedAbsoluteUrl.hash = '!' + decodeURIComponent(escapedFragment);
  }
  return urlParser.format(parsedAbsoluteUrl);
};

const PHANTOM_SCRIPT = Meteor.rootPath + '/assets/packages/jazeee_spiderable-longer-timeout/lib/phantom_script.js';

const badValues = /gzip|deflate|compress|exi|identity|pack200-gzip|brotli|bzip2|lzma|peerdist|sdch|xpress|xz|ostr\.io|_passenger_route\=|heroku-session-affinity\=|__cfduid\=/i;
const badHeaders = /cache-control|server|date|cf-ray|x-cache-status|x-real-ip|x-powered-by|x-runtime|cf-connecting-ip|cf-ipcountry|x-preprender-status|x-prerender-status|cf-cache-status|etag|expires|last-modified|alt-svc|link|age|keep-alive|nncoection|pragma|connection|www-authenticate|via|set-cookie|vary|x-accel-expires|x-accel-redirect|x-accel-limit-rate|x-accel-buffering|x-cache-status|x-accel-charset/i;

const responseHandler = (res, result = {}) => {
  if (result.status === null || result.status === 'null') {
    result.status = 404;
  }

  result.status = isNaN(result.status) ? 200 : parseInt(result.status);

  if (result.headers && result.headers.length > 0) {
    for (let i = 0; i < result.headers.length; i++) {
      if (!badValues.test(result.headers[i].value) && !badHeaders.test(result.headers[i].name)) {
        try {
          res.setHeader(result.headers[i].name, result.headers[i].value);
        } catch (e) {
          // Silence here...
        }
      }
    }
  } else {
    res.setHeader('Content-Type', 'text/html');
  }

  res.writeHead(result.status);
  res.end(result.content);
};

WebApp.connectHandlers.use((req, res, next) => {
  if ((/\?.*_escaped_fragment_=/.test(req.url) || _.any(Spiderable.userAgentRegExps, (re) => {
    return re.test(req.headers['user-agent']);
  })) && !_.any(Spiderable.ignoredRoutes, (route) => {
    return req.url.indexOf(route) > -1;
  })) {
    Spiderable.originalRequest = req;
    const url = Spiderable._urlForPhantom(Meteor.absoluteUrl(), req.url);
    const hash = new Buffer(url).toString('base64');
    const cached = cacheCollection.findOne({
      hash: hash
    });

    if (cached) {
      responseHandler(res, cached);
      if (Spiderable.debug) {
        console.info('Spiderable successfully completed [from cache] for url: [' + cached.status + '] ' + url);
      }
    } else {
      let phantomJsArgs = process.env.METEOR_PKG_SPIDERABLE_PHANTOMJS_ARGS;
      if (phantomJsArgs == null) {
        phantomJsArgs = '';
      }
      if (phantomJsArgs.indexOf('--load-images=') === -1) {
        phantomJsArgs += ' --load-images=no';
      }
      if (phantomJsArgs.indexOf('--ssl-protocol=') === -1) {
        phantomJsArgs += ' --ssl-protocol=TLSv1';
      }
      if (phantomJsArgs.indexOf('--ignore-ssl-errors=') === -1) {
        phantomJsArgs += ' --ignore-ssl-errors=true';
      }
      if (Spiderable.allowRedirects && phantomJsArgs.indexOf('--web-security=false') === -1) {
        phantomJsArgs += ' --web-security=false';
      }
      
      const fullCommand = 'phantomjs ' + phantomJsArgs + ' ' + PHANTOM_SCRIPT + ' ' + (JSON.stringify(url));
      child_process.exec(fullCommand, {
        timeout: REQUEST_TIMEOUT_IN_MILLISECONDS,
        maxBuffer: MAX_BUFFER
      }, (error, stdout, stderr) => {
        bindEnvironment(() => {
          if (!error) {
            if (stdout.length) {
              try {
                const output = JSON.parse(stdout.replace(/^(?!(\{.*\})$)(.*)|\r\n/gim, ''));
                responseHandler(res, output);
                if (Spiderable.debug) {
                  console.info('Spiderable successfully completed for url: [' + output.status + '] ' + url);
                }
                cacheCollection.upsert({
                  hash: hash
                }, {
                  '$set': {
                    hash: hash,
                    url: url,
                    headers: output.headers,
                    content: output.content,
                    status: output.status,
                    createdAt: new Date
                  }
                });
                return;
              } catch (_error) {
                error = _error;
                console.error(error, 'Probably failed to parse PhantomJS output from: ', stdout);
              }
            } else {
              if (Spiderable.debug) {
                console.info('Meteor application returned empty response');
              }
              responseHandler(res, {
                status: 204,
                content: ''
              });
            }
          }

          if (Spiderable.debug) {
            console.error('Spiderable failed for url: ', url, error, stdout, stderr);
          }
          if ((error != null ? error.code : void 0) === 127) {
            console.warn('spiderable: phantomjs not installed. Download and install from http://phantomjs.org/');
          } else {
            console.error('spiderable: phantomjs failed:', error, '\nstderr:', stderr);
          }
          return next();
        });
      });
    }
  } else {
    return next();
  }
});
