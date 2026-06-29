// @ts-nocheck
async function listGitServers({ store }) {
  return {
    status: 200,
    body: {
      gitServers: await store.listGitServers(),
    },
  };
}

export {
  listGitServers,
}
