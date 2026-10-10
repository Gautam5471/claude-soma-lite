/**
 * The MCP transport: newline-delimited JSON-RPC 2.0 over a pair of streams.
 *
 * `soma-bus.mjs` is what Claude Code launches as an MCP server, and this is the
 * whole protocol layer under it: read one JSON object per line from stdin, write
 * one JSON object per line to stdout. Hand-rolled rather than
 * `@modelcontextprotocol/sdk`, deliberately — the wire format is ~40 lines, the
 * project's zero-dependency rule means nothing in `~/.soma` can break because an
 * SDK minor bumped, and a lead's session must not be able to fail on an npm
 * install. The five methods below are all of MCP a tools-only server needs.
 *
 * Two contracts the bus leans on, in order of importance:
 *
 *   Never die. Every response is a reply to something the *client* controls, so
 *   every failure mode a peer can reach — a truncated line, a batch array, a
 *   handler that rejects, a result with a cycle in it — has to become a JSON-RPC
 *   error or a skipped line. A crash here doesn't lose one tool call; it takes
 *   the orchestrator's only control plane down mid-fleet. Which is also why the
 *   `data` listener is synchronous: an `async` listener returns a promise the
 *   EventEmitter drops on the floor, and under Node's default
 *   `--unhandled-rejections=throw` one unguarded reject inside it ends the
 *   process at the next microtask checkpoint (the same trap `fleet.mjs`'s
 *   `refuseThenable` was written for).
 *
 *   Never lose the frame. Every message is one `output.write` of
 *   `JSON.stringify(msg) + '\n'` — and `JSON.stringify` escapes newlines, so no
 *   payload, however hostile (a lead's multi-line summary, a captured pane, a
 *   stack trace), can forge a frame boundary and desynchronize the client's
 *   reader.
 *
 * Read `io` as the seam: `{input, output}` defaults to the real stdio, and the
 * tests drive the entire protocol over a pair of `PassThrough`s.
 */
import { StringDecoder } from 'node:string_decoder';

/**
 * The MCP revision this server speaks.
 *
 * Pinned, not echoed. Version negotiation says: "If the server supports the
 * requested protocol version, it MUST respond with the same version. Otherwise,
 * the server MUST respond with another protocol version it supports" — so
 * answering 2024-11-05 to a client that asked for something newer is the second
 * clause, not a violation. 2024-11-05 is the first stable revision and the
 * baseline every current client still accepts; nothing below is version-specific
 * (`tools/list`, `tools/call` and the two notifications are unchanged in every
 * later revision), so there is nothing to gain by tracking the newest one.
 */
const PROTOCOL = '2024-11-05';

/** Identity in the initialize reply — the name an operator sees in `claude mcp list`. */
const SERVER_INFO = { name: 'soma', version: '0.1.0' };

/**
 * How much of an unterminated line to hold before giving up on it.
 *
 * The line buffer is the one place a peer controls unbounded growth, and the
 * failure at the end of that road is not a slow bus: `buf += chunk` throws
 * `RangeError: Invalid string length` at V8's ~512MB string cap, from the first
 * statement of the reader, which is the one place an exception is fatal. So the
 * fragment is dropped long before that, and the guarantee stops depending on the
 * peer's manners.
 *
 * 16 MiB is chosen to be unreachable by anything real rather than to be tight: a
 * tool call's arguments come from a model's context and a result is a summary, a
 * status object or a capped transcript tail — kilobytes, three orders of
 * magnitude below this. Anything past it is a peer that has stopped framing.
 */
const MAX_LINE = 16 * 1024 * 1024;

/**
 * One line of text for whatever a handler threw.
 *
 * `e.message` alone is the trap: a dep that does `throw null` (or a rejected
 * `Promise.reject()`) makes `e.message` a TypeError *inside the catch block*,
 * which becomes an unhandled rejection and kills the bus — exactly the crash the
 * error response exists to prevent. Every step here is guarded, including
 * `String(e)`, which a `toString` that throws would otherwise take down.
 */
const reason = (e) => {
  try {
    const message = e?.message;
    if (typeof message === 'string' && message !== '') return message;
    const text = String(e);
    return text === '' ? 'unknown error' : text;
  } catch {
    return 'unknown error';
  }
};

/**
 * Serve MCP over `io.input`/`io.output` (default: this process's stdio).
 *
 * `tools` is a live `Map<name, async (args) => any>` and is read on every
 * `tools/list` — never snapshotted. That is load-bearing: `soma-bus.mjs` grows
 * the candidate's Map into the orchestrator's in place after a successful
 * `soma_adopt` and then calls `emitToolsChanged()`, and a snapshot would leave
 * the promoted session re-listing the two tools it started with forever.
 *
 * Returns `{emitToolsChanged}` — the promotion announcement, and the only thing
 * this server ever says unprompted.
 */
export function serve({ tools, describe, onNotify }, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;

  /**
   * One message, one line, one write.
   *
   * The two failures here are not the same failure, so only one of them is
   * swallowed. Serializing the message can throw — a `describe` that returns
   * something with a cycle in it — and that is a caller's bug the client should
   * hear about, so it is left to propagate into the dispatcher's error reply;
   * silently dropping a response is the one outcome a client cannot recover
   * from. Writing can throw on a torn-down stream, and that is the ordinary end
   * of a session (see the 'error' listener below), so it is swallowed.
   */
  const send = (msg) => {
    const line = `${JSON.stringify(msg)}\n`;
    try {
      output.write(line);
    } catch {
      // Unactionable by construction — the peer is gone.
    }
  };

  /**
   * Responses, and the id guard.
   *
   * JSON-RPC 2.0: a Notification (no id) gets no Response, ever. Without this
   * check a `tools/call` sent as a notification would put `{"jsonrpc":"2.0",
   * "result":…}` on the wire — `JSON.stringify` drops the undefined `id` — which
   * is not a valid response and which no client can correlate. The side effect
   * still happens; only the reply is suppressed.
   *
   * `!= null`, never a truthiness test: Claude Code 2.1.220 numbers its
   * `initialize` request `"id":0` (measured on the wire), so `if (msg.id)` would
   * read the first message of every session as a notification, answer nothing,
   * and hang the handshake.
   */
  const ok = (id, result) => { if (id != null) send({ jsonrpc: '2.0', id, result }); };
  const err = (id, code, message) => { if (id != null) send({ jsonrpc: '2.0', id, error: { code, message } }); };

  /**
   * The reply for when building the intended reply threw — the last word on
   * "never dies", and on "never leaves a request unanswered".
   *
   * `ok`/`err` can throw exactly one way, and it is peer-reachable: the id is the
   * peer's, and it goes into a response we then serialize. `JSON.parse` accepts
   * ~500k levels of nesting where `JSON.stringify` of the wrapping response
   * overflows the stack past ~10k (measured), so
   * `{"jsonrpc":"2.0","id":[[[[…]]]],"method":"tools/list"}` is a single line that
   * parses cleanly and then makes the response un-framable — a RangeError out of
   * the reader, i.e. an uncaught exception that kills the bus.
   *
   * So: answer with a frame that is serializable by construction. A flat object,
   * a fixed ASCII message, and an id normalized to `null` — which is JSON-RPC's
   * own rule for a request whose id we cannot echo. Only ever reached after a
   * real attempt failed, so it cannot manufacture a response to a notification
   * (a notification's `err` is a no-op and never throws).
   */
  const lastResort = (id) => {
    try {
      send({ jsonrpc: '2.0', id: id == null || typeof id === 'object' ? null : id, error: { code: -32603, message: 'internal error' } });
    } catch {
      // Nothing left to try. The caller must survive this either way, which is
      // the whole point of the two call sites below.
    }
  };

  /**
   * Writing to a pipe whose reader is gone raises EPIPE as an *event*, and an
   * unhandled 'error' event is an uncaught exception. That case is the ordinary
   * end of every session — Claude Code closes the pipes when it exits, and a
   * response already in flight loses the race — so it must not become a stack
   * trace in the MCP log that reads like a soma crash. Stdout is also the only
   * channel this module has, so there is nowhere to report it to.
   *
   * `input` deliberately gets no such handler: an error *there* is not routine,
   * nothing is left to serve, and surfacing it is more useful than hiding it.
   */
  output.on('error', () => {});

  /**
   * `tools/call` dispatch: serialized, one at a time, in arrival order.
   *
   * Two reasons, one of them structural. Node's EventEmitter calls listeners
   * synchronously and discards what they return, so awaiting inside the reader
   * means a second `data` event re-enters it mid-flight — two handlers
   * interleaving at every await, sharing the line buffer. And the state modules
   * are built on the opposite assumption: `fleet.mjs`'s lock is re-entrant
   * precisely *because* "every acquisition here is synchronous … there is no
   * await between acquire and release for another caller to interleave into",
   * which stops being true the moment two handlers each hold a lock section
   * across an await. A promise chain costs one variable and makes the bus's
   * effects a single-file queue, which is also how the event log reads.
   *
   * Serializing *only* tool calls is the other half: `initialize`, `ping` and
   * `tools/list` are answered synchronously below, so a wedged handler cannot
   * make the whole server look dead to a client that pings — and the promotion's
   * `tools/list` still gets the upgraded Map while `soma_adopt` is settling.
   *
   * The step cannot reject (its body is one try/catch), and the trailing `catch`
   * is the backstop that guarantees it: a rejected link would poison every
   * `.then` chained after it and the bus would go quiet.
   */
  let queue = Promise.resolve();
  const call = (msg) => {
    queue = queue
      .then(async () => {
        try {
          const name = msg.params?.name;
          // A malformed call is not a missing tool. `unknown tool undefined`
          // reaches the model verbatim and reads like a soma bug, so say what is
          // actually wrong: -32602 is "invalid params", which this is.
          if (typeof name !== 'string') { err(msg.id, -32602, 'missing params.name'); return; }
          const fn = tools.get(name);
          // -32601 for a real name that is not in this role's Map, by design.
          // (The MCP spec's own example uses -32602 for an unknown tool; both are
          // "protocol error, not tool failure", and the bus's contract is the
          // narrower one.)
          if (!fn) { err(msg.id, -32601, `unknown tool ${name}`); return; }
          const result = await fn(msg.params?.arguments || {});
          // `?? null` because JSON.stringify(undefined) is *undefined*, not a
          // string: a handler that returns nothing — `soma_send`, `soma_kill` —
          // would otherwise emit `{"type":"text"}` with the text key missing.
          ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] });
        } catch (e) {
          // Every handler failure the bus can produce lands here: a validation
          // refusal, a lost lease CAS, a dead tmux pane — and a result with a
          // cycle or a BigInt in it, since the stringify above is inside the try.
          //
          // The inner guard is for the error reply *itself* failing to serialize:
          // unguarded, that rejects the step, the `.catch` below swallows it, and
          // the client gets silence — the one outcome it cannot recover from.
          try { err(msg.id, -32000, reason(e)); } catch { lastResort(msg.id); }
        }
      })
      // Belt for the braces above: a rejected link would poison every `.then`
      // chained after it and the bus would go quiet for the rest of the session.
      .catch(() => {});
  };

  /** Route one well-formed message. Throwing is contained by the caller. */
  const dispatch = (msg) => {
    switch (msg.method) {
      case 'initialize':
        // listChanged is what licenses emitToolsChanged: a client only refreshes
        // its tool list on notification if the server said it would send one.
        ok(msg.id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: true } }, serverInfo: SERVER_INFO });
        return;

      case 'notifications/initialized':
        // The client's end of the handshake. Nothing to answer, and not an
        // `onNotify` event either — that seam is for notifications this
        // transport does not implement.
        return;

      case 'ping':
        // "The receiver MUST respond promptly with an empty response." Answering
        // -32601 instead would let a pinging client decide the bus is stale and
        // tear the connection down.
        ok(msg.id, {});
        return;

      case 'tools/list':
        // `(n) => describe(n)`, not `.map(describe)`: `map` also passes the index
        // and the array, and a `describe` with a second parameter would silently
        // receive them.
        ok(msg.id, { tools: [...tools.keys()].map((n) => describe(n)) });
        return;

      case 'tools/call':
        call(msg);
        return;

      default:
        // A request for something we do not implement gets an answer — the id
        // check comes *first* precisely so it does. (Reversed, as in the original
        // sketch, an unknown method with an id went to `onNotify` and the client
        // waited for a response that was never coming.) A notification is the
        // other half: `notifications/cancelled` arrives here when an operator
        // interrupts a turn.
        if (msg.id != null) err(msg.id, -32601, `method not found: ${msg.method}`);
        else if (onNotify) onNotify(msg);
    }
  };

  /**
   * A `StringDecoder`, not `chunk.toString()`.
   *
   * Chunk boundaries fall wherever the pipe's buffer ends, which is not where
   * characters end: decoding each chunk on its own turns a UTF-8 sequence split
   * across two of them into U+FFFD and the line stops being parseable JSON. A
   * lead's summary carries exactly the characters this happens to — an emoji, an
   * accented name, a smart quote from an LLM. The decoder holds the incomplete
   * tail until the rest arrives. (A caller that already put the stream in string
   * mode hands us strings, which pass straight through.)
   */
  const decoder = new StringDecoder('utf8');
  let buf = '';

  input.on('data', (chunk) => {
    try {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl;
      // A chunk may hold several messages, part of one, or both — so drain every
      // complete line and keep the remainder for the next chunk.
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();   // trim also absorbs a CRLF's \r
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // Deliberately silent. The spec's answer is -32700 with a null id, but
          // a peer that garbled a line cannot correlate that response to
          // anything, and stdout is a strictly framed channel shared with real
          // replies — noise on it is worse than a dropped line.
          continue;
        }

        // Only an object with a string `method` is a request or a notification.
        // This drops the peer's own responses (no method), JSON-RPC batch arrays
        // (not part of 2024-11-05), and bare scalars — each of which would
        // otherwise throw on the property access and take the reader with it.
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') continue;

        try {
          dispatch(msg);
        } catch (e) {
          // Nothing above should throw; if a caller's `describe` or `onNotify`
          // does, the client still gets an answer instead of silence.
          //
          // And this recovery is itself guarded, because it is the last frame
          // between a throw and the `data` listener: an exception escaping here
          // is an uncaught exception, and an uncaught exception is a dead bus. A
          // 50k-deep peer id makes `err` throw the same RangeError that got us
          // here (see `lastResort`), so this is reachable from one crafted line.
          try { err(msg.id, -32603, reason(e)); } catch { lastResort(msg.id); }
        }
      }

      // Whatever is left is an unterminated fragment — the loop above consumed
      // every complete line — and past MAX_LINE it is not a message any more.
      // Dropping it is what stops `buf +=` from ever reaching the string cap.
      // Checked *after* draining on purpose: a legitimately large but complete
      // line is delivered rather than discarded for its size, and only
      // accumulation without a newline in sight is refused.
      if (buf.length > MAX_LINE) buf = '';
    } catch {
      // The belt — and with it the last unguarded statement in the module.
      // Every reply path above carries its own guard, so reaching here means the
      // *framing* threw: `buf +=` hitting V8's string cap, or `decoder.write` on
      // a chunk that is not a Buffer (an objectMode stream). Reset and keep the
      // connection alive; the next newline resynchronizes it.
      buf = '';
    }
  });

  return {
    /**
     * Announce that the tool list changed — the candidate → orchestrator
     * promotion, and the reason `capabilities.tools.listChanged` is true. A
     * notification: no id, no reply, nothing to await.
     */
    emitToolsChanged: () => { send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); },
  };
}
