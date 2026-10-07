// Native launcher for the fake CLIs on Windows (built per test run with the .NET Framework csc.exe).
//
// Why: the runner spawns the CLI with a plain child_process.spawn (no shell), which on Node >= 20.12 refuses
// .cmd/.bat files (EINVAL) and only resolves .com/.exe names, and node.exe itself rejects claude's argv
// ("-p --output-format ..." -> "bad option"). So the fake CLI needs a real executable that forwards
// its arguments verbatim to `node fake-cli.js <args...>` with inherited stdio and the child's exit code.
// __NODE__ and __SCRIPT__ are replaced by test/fake-cli/index.js before compiling.
using System;
using System.Diagnostics;
using System.Text;

class OrchestraFakeCliShim {
  // Windows (CommandLineToArgvW) quoting: quote when needed, double backslashes before quotes.
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"', '\n' }) < 0) return a;
    StringBuilder sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2);
    sb.Append('"');
    return sb.ToString();
  }

  static int Main(string[] args) {
    StringBuilder cl = new StringBuilder(Quote(@"__SCRIPT__"));
    foreach (string a in args) { cl.Append(' '); cl.Append(Quote(a)); }
    ProcessStartInfo psi = new ProcessStartInfo(@"__NODE__", cl.ToString());
    psi.UseShellExecute = false; // inherit stdin/stdout/stderr handles from the runner
    Process p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
