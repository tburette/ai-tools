import minimist from 'minimist';

export function parseArgs(argv) {
  const args = minimist(argv, {
    string: ['final', 'initial', 'final-file', 'initial-file'],
    alias: {
      f: 'final',
      i: 'initial',
      d: 'delay',
      p: 'port',
      h: 'help'
    },
    boolean: ['help'],
    default: {
      final: 'Final content loaded',
      initial: 'Loading...',
      delay: 3000,
      port: 3000
    }
  });

  return {
    final: args.final,
    initial: args.initial,
    delay: parseInt(args.delay, 10),
    port: parseInt(args.port, 10),
    finalFile: args['final-file'],
    initialFile: args['initial-file'],
    help: args.help
  };
}

export const HELP_TEXT = `delay-server - A web server that swaps content after a delay

Usage:
  delay-server [options]

Options:
  -f, --final <text>       Final content (default: "Final content loaded")
  -i, --initial <text>      Initial content (default: "Loading...")
  -d, --delay <ms>          Delay in milliseconds (default: 3000)
  -p, --port <port>         Server port (default: 3000)
  --final-file <path>      Load final content from file
  --initial-file <path>     Load initial content from file
  -h, --help                Show this help message

Examples:
  delay-server
  delay-server --final "Hello World" --delay 2000
  delay-server --final-file ./content.html --port 8080`;
