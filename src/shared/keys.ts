// Keyboard map (SPEC B10), shared by both windows. The Control forwards the resulting messages.
import type { ControlMsg } from './protocol';
import type { Session } from './state';

export type KeyAction =
  | { kind: 'msg'; msg: ControlMsg }
  | { kind: 'local'; name: 'debug' | 'fullscreen' }
  | null;

const toggle = (session: Session | null, key: 'meltHold' | 'frozen' | 'fallback' | 'blackout'): ControlMsg | null =>
  session ? { t: 'setSession', key, value: !session[key] } : null;

/** Map a KeyboardEvent.key to an action. `session` is the last known Session (null if unknown). */
export function keyAction(key: string, session: Session | null): KeyAction {
  const msg = (m: ControlMsg | null): KeyAction => (m ? { kind: 'msg', msg: m } : null);
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case ' ': case 'ArrowRight': return msg({ t: 'cmd', name: 'next' });
    case 'ArrowLeft': return msg({ t: 'cmd', name: 'prev' });
    case 'h': return msg(toggle(session, 'meltHold'));
    case 'f': return msg(toggle(session, 'frozen'));
    case 'b': return msg(toggle(session, 'fallback'));
    case 'k': return msg(toggle(session, 'blackout'));
    case 'r': return msg({ t: 'cmd', name: 'randomize' });
    case 'm': return msg({ t: 'cmd', name: 'mutate' });
    case 'z': return msg({ t: 'cmd', name: 'undo' });
    case 's': return msg({ t: 'cmd', name: 'savePreset' });
    case 'd': return { kind: 'local', name: 'debug' };
    case 'Enter': return { kind: 'local', name: 'fullscreen' };
    default:
      if (key >= '1' && key <= '9' && key.length === 1) return msg({ t: 'cmd', name: 'loadPreset', arg: Number(key) - 1 });
      return null;
  }
}

/** True when the event target is a text field (keys are ignored there). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type === 'text' || type === 'search' || type === 'number';
  }
  return el.isContentEditable === true;
}
