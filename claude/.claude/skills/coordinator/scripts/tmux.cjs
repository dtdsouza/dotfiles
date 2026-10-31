const { execFileSync } = require('child_process');

const tmuxArgs = (args) => (process.env.COORDINATOR_TMUX_SOCKET ? ['-L', process.env.COORDINATOR_TMUX_SOCKET, ...args] : args);
const tmuxStrict = (args) => execFileSync('tmux', tmuxArgs(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmux = (args) => {
  try {
    return tmuxStrict(args);
  } catch {
    return '';
  }
};

module.exports = { tmux, tmuxStrict };
