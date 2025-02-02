var EventEmitter    = require('events');
var util            = require('util');

var stomp           = require('./lib/stomp');
var stompUtils      = require('./lib/stomp-utils');
var BYTES           = require('./lib/bytes');

var protocolAdapter = require('./lib/adapter');
var buildConfig     = require('./lib/config');

/**
 * STOMP Server configuration
 *
 * @typedef {object} ServerConfig
 * @param {http.Server} server Http server reference
 * @param {string} [serverName=STOMP-JS/VERSION] Name of STOMP server
 * @param {string} [path=/stomp] WebSocket path
 * @param {array} [heartbeat=[10000, 10000]] Heartbeat; read documentation to config according to your desire
 * @param {number} [heartbeatErrorMargin=1000] Heartbeat error margin; specify how strict server should be
 * @param {function} [debug=function(args) {}] Debug function
 */

/**
 * @typedef MsgFrame Message frame object
 * @property {string|Buffer} body Message body, string or Buffer
 * @property {object} headers Message headers
 */

/**
 * @class
 * @augments EventEmitter
 *
 * Create Stomp server with config
 *
 * @param {ServerConfig} config Configuration for STOMP server
 */
var StompServer = function (config) {
  EventEmitter.call(this);

  if (config === undefined) {
    config = {};
  }

  this.conf = buildConfig(config);

  this.subscribes = [];
  this.middleware = {};
  this.frameHandler = new stomp.FrameHandler(this);

  this.socket = new protocolAdapter[this.conf.protocol]({
      ...this.conf.protocolConfig,
      server: this.conf.server,
      path: this.conf.path,
      perMessageDeflate: false
    });
  /**
   * Client connecting event, emitted after socket is opened.
   *
   * @event StompServer#connecting
   * @type {object}
   * @property {string} sessionId
   */
  this.socket.on('connection', function (ws, incomingMessage) {
    ws.__req = incomingMessage;
    ws.sessionId = stompUtils.genId();

    this.emit('connecting', ws.sessionId);
    this.conf.debug('Connect', ws.sessionId);

    ws.on('message', this.parseRequest.bind(this, ws));
    ws.on('close', this.onDisconnect.bind(this, ws));
    ws.on('error', function (err) {
      this.conf.debug(err);
      this.emit('error', err);
    }.bind(this));
  }.bind(this));


  //<editor-fold defaultstate="collapsed" desc="Events">

  /**
   *  Add middle-ware for specific command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command to hook
   *  @param {function} handler function to add in middle-ware
   * */
  this.addMiddleware = function (command, handler) {
    command = command.toLowerCase();
    if (! this.middleware[command] ) {
      this.middleware[command] = [];
    }
    this.middleware[command].push(handler);
  };

  /**
   *  Clear and set middle-ware for specific command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command to hook
   *  @param {function} handler function to add in middle-ware
   * */
  this.setMiddleware = function (command, handler) {
    command = command.toLowerCase();
    this.middleware[command] = [handler];
  };

  /**
   *  Remove middle-ware specific for command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command with hook
   *  @param {function} handler function to remove from middle-ware
   * */
  this.removeMiddleware = function (command, handler) {
    var handlers = this.middleware[command.toLowerCase()];
    var idx = handlers.indexOf(handler);
    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  };


  function withMiddleware(command, finalHandler) {
    return function(socket, args) {
      var handlers = this.middleware[command.toLowerCase()] || [];
      var iter = handlers[Symbol.iterator]();
      var self = this;

      function callNext() {
        var iteration = iter.next();
        if (iteration.done) {
          return finalHandler.call(self, socket, args);
        }
        return iteration.value(socket, args, callNext);
      }
      return callNext();
    };
  }


  /**
   * Client connected event, emitted after connection established and negotiated
   *
   * @event StompServer#connected
   * @type {object}
   * @property {string} sessionId
   * @property {object} headers
   */
  this.onClientConnected = withMiddleware('connect', function (socket, args) {
    socket.clientHeartbeat = {
      client: args.heartbeat[0],
      server: args.heartbeat[1]
    };
    this.conf.debug('CONNECT', socket.sessionId, socket.clientHeartbeat, args.headers);
    this.emit('connected', socket.sessionId, args.headers);
    return true;
  });

  /**
   * Client disconnected event
   *
   * @event StompServer#disconnected
   * @type {object}
   * @property {string} sessionId
   * */
  this.onDisconnect = withMiddleware('disconnect', function (socket /*, receiptId*/) {
    // TODO: Do we need to do anything with receiptId on disconnect?
    this.afterConnectionClose(socket);
    this.conf.debug('DISCONNECT', socket.sessionId);
    this.emit('disconnected', socket.sessionId);
    return true;
  });


  /**
   * Event emitted when broker send message to subscribers
   *
   * @event StompServer#send
   * @type {object}
   * @property {string} dest Destination
   * @property {string} frame Message frame
   */
  this.onSend = withMiddleware('send', function (socket, args, callback) {
    var bodyObj = args.frame.body;
    var frame = this.frameSerializer(args.frame);
    var headers = {
      //default headers
      'message-id': stompUtils.genId('msg'),
      'content-type': 'text/plain'
    };

    if (frame.body !== undefined) {
      if (typeof frame.body !== 'string' && !Buffer.isBuffer(frame.body)) {
        throw 'Message body is not string';
      }
      frame.headers['content-length'] = frame.body.length;
    }

    if (frame.headers) {
      for (var key in frame.headers) {
        headers[key] = frame.headers[key];
      }
    }

    args.frame = frame;
    this.emit('send', {
      frame: {
        headers: frame.headers,
        body: bodyObj
      },
      dest: args.dest
    });

    this._sendToSubscriptions(socket, args);

    if (callback) {
      callback(true);
    }
    return true;
  });


  /**
   * Client subscribe event, emitted when client subscribe topic
   *
   * @event StompServer#subscribe
   * @type {object}
   * @property {string} id Subscription id
   * @property {string} sessionId Socket session id
   * @property {string} topic Destination topic
   * @property {string[]} tokens Tokenized topic
   * @property {object} socket Connected socket
   */
  this.onSubscribe = withMiddleware('subscribe', function (socket, args) {
    var sub = {
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: stompUtils.tokenizeDestination(args.dest),
      socket: socket
    };
    this.subscribes.push(sub);
    this.emit('subscribe', sub);
    this.conf.debug('Server subscribe', args.id, args.dest);
    return true;
  });


  /**
   * Client subscribe event, emitted when client unsubscribe topic
   *
   * @event StompServer#unsubscribe
   * @type {object}
   * @property {string} id Subscription id
   * @property {string} sessionId Socket session id
   * @property {string} topic Destination topic
   * @property {string[]} tokens Tokenized topic
   * @property {object} socket Connected socket
   * @return {boolean}
   */
  this.onUnsubscribe = withMiddleware('unsubscribe', function (socket, subId) {
    for (var i = 0; i < this.subscribes.length; i++) {
      var sub = this.subscribes[i];
      if (sub.id === subId && sub.sessionId === socket.sessionId) {
        this.subscribes.splice(i--, 1);
        this.emit('unsubscribe', sub);
        return true;
      }
    }
    return false;
  });

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Subscribe & Unsubscribe">

  var selfSocket = {
    sessionId: 'self_1234'
  };


  /**
   * Subscription callback method
   *
   * @callback OnSubscribedMessageCallback
   * @param {string} msg Message body
   * @param {object} headers Message headers
   * @param {string} headers.destination Message destination
   * @param {string} headers.subscription Id of subscription
   * @param {string} headers.message-id Id of message
   * @param {string} headers.content-type Content type
   * @param {string} headers.content-length Content length
   */


  /**
   * Subscribe topic
   *
   * @param {string} topic Subscribed destination, wildcard is supported
   * @param {OnSubscribedMessageCallback=} callback Callback function
   * @param {object} headers Optional headers, used by client to provide a subscription ID (headers.id)
   * @return {string} Subscription id, when message is received event with this id is emitted
   * @example
   * stompServer.subscribe('/test.data', function(msg, headers) {});
   * //or alternative
   * var subs_id = stompServer.subscribe('/test.data');
   * stompServer.on(subs_id, function(msg, headers) {});
   */
  this.subscribe = function (topic, callback, headers) {
    var id;
    if (!headers || !headers.id) {
      id = 'self_' + Math.floor(Math.random() * 99999999999);
    } else {
      id = headers.id;
    }
    var sub = {
      topic: topic,
      tokens: stompUtils.tokenizeDestination(topic),
      id: id,
      sessionId: 'self_1234'
    };
    this.subscribes.push(sub);
    this.emit('subscribe', sub);
    if (callback) {
      this.on(id, callback);
    }
    return id;
  };


  /** Unsubscribe topic with subscription id
   *
   * @param {string} id Subscription id
   * @return {boolean} Subscription is deleted
   */
  this.unsubscribe = function (id) {
    this.removeAllListeners(id);
    return this.onUnsubscribe(selfSocket, id);
  };

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Send">

  /**
   * Send message to matching subscribers.
   *
   * @param {object} socket websocket to send the message on
   * @param {string} args onSend args
   * @private
   */
  this._sendToSubscriptions = function (socket, args) {
    for (var i = 0; i < this.subscribes.length; i++) {
      var sub = this.subscribes[i];
      if (socket.sessionId === sub.sessionId) {
        continue;
      }
      var match = this._checkSubMatchDest(sub, args);
      if (match) {
        args.frame.headers.subscription = sub.id;
        args.frame.command = 'MESSAGE';
        var sock = sub.socket;
        if (sock !== undefined) {
          stompUtils.sendFrame(sock, args.frame);
        } else {
          this.emit(sub.id, args.frame.body, args.frame.headers);
        }
      }
    }
  };


  /** Send message to topic
   *
   * @param {string} topic Destination for message
   * @param {Object.<string, string>} headers Message headers
   * @param {string} body Message body
   */
  this.send = function (topic, headers, body) {
    var _headers = {};
    if (headers) {
      for (var key in headers) {
        _headers[key] = headers[key];
      }
    }
    var frame = {
      body: body,
      headers: _headers
    };
    var args = {
      dest: topic,
      frame: this.frameParser(frame)
    };
    this.onSend(selfSocket, args);
  }.bind(this);

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Frames">

  /**
   * Serialize frame to string for send
   *
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameSerializer = function (frame) {
    if (frame.body !== undefined && frame.headers['content-type'] === 'application/json' && !Buffer.isBuffer(frame.body)) {
      frame.body = JSON.stringify(frame.body);
    }
    return frame;
  };


  /**
   * Parse frame to object for reading
   *
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameParser = function (frame) {
    if (frame.body !== undefined && frame.headers['content-type'] === 'application/json') {
      frame.body = JSON.parse(frame.body);
    }
    return frame;
  };

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Heartbeat">

  /**
   * Heart-beat: Turn On for given socket
   *
   * @param {WebSocket} socket Destination WebSocket
   * @param {number} interval Heart-beat interval
   * @param {boolean} serverSide If true then server is responsible for sending pings
   * */
  this.heartbeatOn = function (socket, interval, serverSide) {
    var self = this;

    if (serverSide) {
      // Server takes responsibility for sending pings
      // Client should close connection on timeout
      socket.heartbeatClock = setInterval(function() {
        if(socket.readyState === 1) {
          self.conf.debug('PING');
          socket.send(BYTES.LF);
        }
      }, interval);

    } else {
      // Client takes responsibility for sending pings
      // Server should close connection on timeout
      socket.heartbeatTime = Date.now() + interval;
      socket.heartbeatClock = setInterval(function() {
        var diff = Date.now() - socket.heartbeatTime;
        if (diff > interval + self.conf.heartbeatErrorMargin) {
          self.conf.debug('HEALTH CHECK failed! Closing', diff, interval);
          socket.close();
        } else {
          self.conf.debug('HEALTH CHECK ok!', diff, interval);
          socket.heartbeatTime -= diff;
        }
      }, interval);
    }
  };


  /**
   * Heart-beat: Turn Off for given socket
   *
   * @param {WebSocket} socket Destination WebSocket
   * */
  this.heartbeatOff = function (socket) {
    if(socket.heartbeatClock !== undefined) {
      clearInterval(socket.heartbeatClock);
      delete socket.heartbeatClock;
    }
  };

  //</editor-fold>


  /**
   * Test if the input subscriber has subscribed to the target destination.
   *
   * @param sub the subscriber
   * @param args onSend args
   * @returns {boolean} true if the input subscription matches destination
   * @private
   */
  this._checkSubMatchDest = function (sub, args) {
    var match = true;
    var tokens = stompUtils.tokenizeDestination(args.dest);
    for (var t in tokens) {
      var token = tokens[t];
      if (sub.tokens[t] === undefined || (sub.tokens[t] !== token && sub.tokens[t] !== '*' && sub.tokens[t] !== '**')) {
        match = false;
        break;
      } else if (sub.tokens[t] === '**') {
        break;
      }
    }
    return match;
  };


  /**
   * After connection close
   *
   * @param socket WebSocket connection that has been closed and is dying
   */
  this.afterConnectionClose = function (socket) {
    // remove from subscribes
    for (var i = 0; i < this.subscribes.length; i++) {
      var sub = this.subscribes[i];
      if (sub.sessionId === socket.sessionId) {
        this.subscribes.splice(i--, 1);
      }
    }

    // turn off server side heart-beat (if needed)
    this.heartbeatOff(socket);
  };


  this.parseRequest = function(socket, data) {
    // check if it's incoming heartbeat
    if (socket.heartbeatClock !== undefined) {
      // beat
      socket.heartbeatTime = Date.now();

      // if it's ping then ignore
      if(data === BYTES.LF) {
        this.conf.debug('PONG');
        return;
      }
    }

    // normal data
    var frame = stompUtils.parseFrame(data);
    var cmdFunc = this.frameHandler[frame.command];
    if (cmdFunc) {
      frame = this.frameParser(frame);
      return cmdFunc(socket, frame);
    }

    return 'Command not found';
  };

};

util.inherits(StompServer, EventEmitter);

// Export
module.exports = StompServer;
