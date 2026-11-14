import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import type { LinkStatus, PathKind, Role } from "./lib/link";
import { fromDrop, fromInput } from "./lib/pick";
import { Session, type SessionState } from "./lib/session";
import { supportsFolderSink } from "./lib/sinks";
import {
  CODE_LENGTH,
  formatBytes,
  formatDuration,
  isValidCode,
  normalizeCode,
  randomCode,
} from "./lib/util";

function openSession(role: Role, code: string): Session {
  const session = new Session(role, code);
  if (import.meta.env.DEV) (window as any).__sher = session;
  return session;
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const code = normalizeCode(location.hash.slice(1));
    return isValidCode(code) ? openSession("guest", code) : null;
  });

  const leave = () => {
    session?.close();
    history.replaceState(null, "", location.pathname + location.search);
    setSession(null);
  };

  return (
    <main className={session ? "page narrow" : "page"}>
      <header className="topbar">
        <div className="wordmark" aria-label="Sherrr">
          Sher<span>r</span>
          <span>r</span>
        </div>
        {session && <TopbarStatus session={session} onLeave={leave} />}
      </header>
      {session ? (
        <SessionView key={session.getState().code} session={session} onLeave={leave} />
      ) : (
        <Home onStart={(role, code) => setSession(openSession(role, code))} />
      )}
    </main>
  );
}

// ---- home ------------------------------------------------------------------

function Home({ onStart }: { onStart: (role: Role, code: string) => void }) {
  const [code, setCode] = useState("");
  const valid = isValidCode(code);
  return (
    <>
      <h1 className="lede">Send big files straight to another device.</h1>
      <p className="body">
        No upload, no account, no size limit. Files go directly from this device to the other one.
      </p>
      <div className="duo">
        <section className="sheet">
          <span className="eyebrow">Send</span>
          <h2 className="title">Share from this device</h2>
          <p className="body">You get a code. Open it on the device that should receive the files.</p>
          <button className="btn solid block" onClick={() => onStart("host", randomCode())}>
            <ArrowUp />
            Send files
          </button>
        </section>
        <section className="sheet">
          <span className="eyebrow">Receive</span>
          <h2 className="title">Enter the sender's code</h2>
          <p className="body">Type the six characters shown on the sending device.</p>
          <form
            className="join"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) onStart("guest", code);
            }}
          >
            <input
              className="field"
              aria-label="Code"
              placeholder="ABC123"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
            />
            <button className="btn outline" type="submit" disabled={!valid}>
              Connect
            </button>
          </form>
        </section>
      </div>
    </>
  );
}

function ArrowUp() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

// ---- session ---------------------------------------------------------------

const FATAL_TEXT: Record<string, string> = {
  "no-such-room": "No one is sharing with that code. Check the code and try again.",
  "room-full": "Two devices are already connected with this code.",
};

const STATUS_TEXT: Record<LinkStatus, string> = {
  server: "Starting",
  waiting: "Waiting for the other device",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
};

const PATH_TEXT: Record<PathKind, string> = {
  local: "same network",
  internet: "over the internet",
  relay: "through a relay",
};

function TopbarStatus({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  if (state.fatal) return null;
  const live = state.link === "connected";
  return (
    <div className="topbar-end">
      <span className="status" role="status">
        <span className={`dot ${live ? "live" : "wait"}`} />
        <span className="status-text">
          {STATUS_TEXT[state.link]}
          {live && state.path && <span className="status-path"> · {PATH_TEXT[state.path]}</span>}
        </span>
      </span>
      {(live || state.link === "reconnecting") && (
        <button className="btn quiet small" onClick={onLeave}>
          Disconnect
        </button>
      )}
    </div>
  );
}

function SessionView({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);

  if (state.fatal) {
    return (
      <section className="sheet">
        <h2 className="title">Could not connect</h2>
        <p className="body">{FATAL_TEXT[state.fatal] ?? `The connection was refused (${state.fatal}).`}</p>
        <button className="btn outline" onClick={onLeave}>
          Back
        </button>
      </section>
    );
  }

  const paired = state.link === "connected" || state.link === "reconnecting";
  if (!paired) {
    return state.role === "host" ? (
      <Pairing code={state.code} onCancel={onLeave} />
    ) : (
      <section className="sheet">
        <h2 className="title">Connecting to the sending device</h2>
        <p className="body">This usually takes a few seconds.</p>
        <button className="btn outline" onClick={onLeave}>
          Cancel
        </button>
      </section>
    );
  }
  return state.role === "host" ? (
    <HostPanel session={session} state={state} />
  ) : (
    <GuestPanel session={session} state={state} />
  );
}

function Pairing({ code, onCancel }: { code: string; onCancel: () => void }) {
  const url = `${location.origin}${location.pathname}#${code}`;
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 0, width: 440 }).then(setQr, () => setQr(""));
  }, [url]);

  return (
    <section className="sheet center">
      <h2 className="title">Connect the other device</h2>
      <p className="body">Scan with its camera, or open Sherrr there and type the code.</p>
      {qr && (
        <div className="qr">
          <img src={qr} alt="QR code that opens the receiving page" />
        </div>
      )}
      <div className="cells" data-testid="room-code" data-code={code} aria-label={`Code ${code.split("").join(" ")}`}>
        {code.split("").map((char, i) => (
          <span key={i} aria-hidden="true">
            {char}
          </span>
        ))}
      </div>
      <div className="actions stretch">
        <button
          className="btn outline"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? "Link copied" : "Copy link"}
        </button>
        <button className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

// ---- host (sender) ---------------------------------------------------------

function HostPanel({ session, state }: { session: Session; state: SessionState }) {
  if (state.phase === "offered") {
    return (
      <section className="sheet">
        <span className="eyebrow">Offered</span>
        <h2 className="title">Waiting for the other device to accept</h2>
        <p className="body">{summary(state.files.length, state.totalBytes)}</p>
        <button className="btn outline" onClick={() => session.cancel()}>
          Cancel
        </button>
      </section>
    );
  }
  if (state.phase === "transferring") return <Progress session={session} state={state} verb="Sending" />;
  return (
    <>
      {state.phase === "done" && (
        <Notice tone="ok" onDismiss={() => session.reset()}>
          Sent {summary(state.files.length, state.totalBytes)}.
        </Notice>
      )}
      {state.phase === "declined" && (
        <Notice tone="plain" onDismiss={() => session.reset()}>
          The other device declined the files.
        </Notice>
      )}
      {state.phase === "error" && (
        <Notice tone="bad" onDismiss={() => session.reset()}>
          {state.error}
        </Notice>
      )}
      <FilePicker session={session} state={state} />
    </>
  );
}

function FilePicker({ session, state }: { session: Session; state: SessionState }) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const canPickFolder = "webkitdirectory" in HTMLInputElement.prototype;
  const { count, bytes } = state.picked;

  return (
    <section className="sheet">
      <h2 className="title">Choose what to send</h2>
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void fromDrop(e.dataTransfer).then((files) => session.addFiles(files));
        }}
      >
        <p className="body">Drop files or folders here</p>
        <div className="actions middle">
          <button className="btn outline small" onClick={() => filesInput.current?.click()}>
            Add files
          </button>
          {canPickFolder && (
            <button className="btn outline small" onClick={() => folderInput.current?.click()}>
              Add folder
            </button>
          )}
        </div>
      </div>
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          session.addFiles(fromInput(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          session.addFiles(fromInput(e.target.files));
          e.target.value = "";
        }}
      />
      {count > 0 && (
        <div className="tally">
          <span>
            <strong>{fileCount(count)}</strong> · {formatBytes(bytes)}
          </span>
          <button className="btn quiet small" onClick={() => session.clearFiles()}>
            Clear
          </button>
        </div>
      )}
      <button
        className="btn solid block"
        disabled={count === 0 || state.link !== "connected"}
        onClick={() => session.send()}
      >
        {count === 0 ? "Send" : `Send ${fileCount(count)}`}
      </button>
    </section>
  );
}

// ---- guest (receiver) ------------------------------------------------------

function GuestPanel({ session, state }: { session: Session; state: SessionState }) {
  const [busy, setBusy] = useState(false);
  const folderMode = supportsFolderSink();

  if (state.phase === "none" || state.phase === "declined") {
    return (
      <section className="sheet">
        <h2 className="title">Ready to receive</h2>
        <p className="body">Connected. Waiting for the other device to choose files.</p>
      </section>
    );
  }
  if (state.phase === "offered") {
    return (
      <section className="sheet">
        <span className="eyebrow">Incoming</span>
        <h2 className="title">
          {fileCount(state.files.length)} · {formatBytes(state.totalBytes)}
        </h2>
        <FileList state={state} />
        {!folderMode && (
          <p className="fine">
            This browser can't save straight into a folder, so files are kept in the browser until you save each
            one. For very large transfers, use Chrome or Edge on a computer.
          </p>
        )}
        {state.error && <p className="fine alarm">{state.error}</p>}
        <div className="actions stretch">
          <button
            className="btn solid"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void session.accept().finally(() => setBusy(false));
            }}
          >
            {folderMode ? "Choose folder and receive" : "Receive"}
          </button>
          <button className="btn outline" disabled={busy} onClick={() => session.decline()}>
            Decline
          </button>
        </div>
      </section>
    );
  }
  return (
    <>
      {state.phase === "transferring" && <Progress session={session} state={state} verb="Receiving" />}
      {state.phase === "done" && (
        <Notice tone="ok">Received {summary(state.files.length, state.totalBytes)}.</Notice>
      )}
      {state.phase === "error" && <Notice tone="bad">{state.error}</Notice>}
      {state.inMemory && state.phase === "transferring" && (
        <p className="fine">Files are being held in memory in this browser, so keep this transfer small.</p>
      )}
      {state.saved.length > 0 && (
        <section className="sheet">
          <h2 className="title">Save your files</h2>
          <ul className="rows">
            {state.saved.map((file) => (
              <li key={file.url}>
                <span className="name">{file.name}</span>
                <span className="size">{formatBytes(file.size)}</span>
                <a className="btn outline small" href={file.url} download={file.name}>
                  Save
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---- shared pieces ---------------------------------------------------------

function Progress({ session, state, verb }: { session: Session; state: SessionState; verb: string }) {
  const fraction = state.totalBytes > 0 ? state.doneBytes / state.totalBytes : 1;
  const percent = Math.floor(fraction * 100);
  const stalled = state.link !== "connected";
  const mbps = stalled ? 0 : (state.speed * 8) / 1_000_000;
  const eta = formatDuration(state.eta);
  return (
    <section className="sheet">
      <span className="eyebrow">{stalled ? "Paused" : `${verb} ${fileCount(state.files.length)}`}</span>
      <div className={`speed ${stalled ? "idle" : ""}`}>
        <b>{mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(mbps > 0 ? 1 : 0)}</b>
        <span>Mbps</span>
      </div>
      <div
        className={`track ${stalled ? "idle" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${verb} progress`}
      >
        <i style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="meta">
        <span>
          {percent}% · {formatBytes(state.doneBytes)} of {formatBytes(state.totalBytes)}
        </span>
        <span>{stalled ? "Paused" : eta ? `${eta} left` : ""}</span>
      </div>
      <p className={stalled ? "fine" : "fine now"} title={state.currentPath}>
        {stalled
          ? "The transfer continues from where it stopped once the devices reconnect."
          : `${state.filesDone} of ${state.files.length} done · ${state.currentPath}`}
      </p>
      <button className="btn outline" onClick={() => session.cancel()}>
        Cancel
      </button>
    </section>
  );
}

function FileList({ state }: { state: SessionState }) {
  const shown = state.files.slice(0, 5);
  return (
    <ul className="rows">
      {shown.map((file) => (
        <li key={file.id}>
          <span className="name">{file.path}</span>
          <span className="size">{formatBytes(file.size)}</span>
        </li>
      ))}
      {state.files.length > shown.length && (
        <li>
          <span className="fine">and {(state.files.length - shown.length).toLocaleString("en")} more</span>
        </li>
      )}
    </ul>
  );
}

function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "ok" | "plain" | "bad";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`note ${tone === "bad" ? "bad" : ""}`} role={tone === "bad" ? "alert" : "status"}>
      <span className={`dot ${tone === "ok" ? "live" : ""}`} />
      <p>{children}</p>
      {onDismiss && (
        <button className="btn quiet small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString("en")} files`;
}

function summary(count: number, bytes: number): string {
  return `${fileCount(count)}, ${formatBytes(bytes)}`;
}
