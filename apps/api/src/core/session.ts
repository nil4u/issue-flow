// @ts-nocheck
import { publicSession } from './common.js'

async function getSession({ store, sessionId }) {
  const session = await store.getSession(sessionId);
  return {
    status: 200,
    body: session
      ? { authenticated: true, session: publicSession(session), user: session.user, gitServer: session.gitServer }
      : { authenticated: false },
  };
}

export {
  getSession,
}
