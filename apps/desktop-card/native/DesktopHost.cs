using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Hosts only the HWND owned by the supplied Electron PID. It never changes
// Explorer's wallpaper, icon view, styles, or other application windows.
internal static class DesktopHost
{
    private const int GWL_STYLE = -16;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_POPUP = 0x80000000L;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string title);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern int MapWindowPoints(IntPtr from, IntPtr to, ref Point point, uint count);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    private static string ClassName(IntPtr hwnd)
    {
        var text = new StringBuilder(256);
        GetClassName(hwnd, text, text.Capacity);
        return text.ToString();
    }

    private static bool IsDesktopHost(IntPtr hwnd)
    {
        string name = ClassName(hwnd);
        return IsWindow(hwnd) && (name == "Progman" || name == "WorkerW") &&
            FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero;
    }

    private static IntPtr FindDesktopHost()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            if (!IsDesktopHost(hwnd)) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static long Style(IntPtr hwnd)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, GWL_STYLE).ToInt64() : (long)(uint)GetWindowLong32(hwnd, GWL_STYLE);
    }

    private static void SetStyle(IntPtr hwnd, long style)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, GWL_STYLE, new IntPtr(style));
        else SetWindowLong32(hwnd, GWL_STYLE, unchecked((int)style));
    }

    private static void Attach(IntPtr hwnd, IntPtr parent)
    {
        Rect rect;
        if (!GetWindowRect(hwnd, out rect)) throw new Win32Exception();
        IntPtr previousParent = GetParent(hwnd);
        long previousStyle = Style(hwnd);
        SetStyle(hwnd, (previousStyle & ~WS_POPUP) | WS_CHILD);
        SetParent(hwnd, parent);
        if (GetParent(hwnd) != parent)
        {
            int error = Marshal.GetLastWin32Error();
            SetStyle(hwnd, previousStyle);
            SetParent(hwnd, previousParent);
            throw new Win32Exception(error);
        }
        Move(hwnd, rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    private static void Move(IntPtr hwnd, int x, int y, int width, int height)
    {
        var point = new Point { X = x, Y = y };
        MapWindowPoints(IntPtr.Zero, GetParent(hwnd), ref point, 1);
        if (!SetWindowPos(hwnd, IntPtr.Zero, point.X, point.Y, width, height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW)) throw new Win32Exception();
    }

    private static void Report(IntPtr hwnd, string error)
    {
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        IntPtr parent = GetParent(hwnd);
        Rect rect;
        GetWindowRect(hwnd, out rect);
        string message = (error ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        Console.WriteLine("{\"ownerPid\":" + owner + ",\"windowHandle\":\"" + hwnd.ToInt64() + "\",\"attached\":" + (IsDesktopHost(parent) && (Style(hwnd) & WS_CHILD) != 0 ? "true" : "false") +
            ",\"parentClass\":\"" + ClassName(parent) + "\",\"visible\":" + (IsWindowVisible(hwnd) ? "true" : "false") +
            ",\"bounds\":{\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"width\":" + (rect.Right - rect.Left) +
            ",\"height\":" + (rect.Bottom - rect.Top) + "},\"error\":\"" + message + "\"}");
        Console.Out.Flush();
    }

    private static int Main(string[] args)
    {
        long handle;
        uint owner;
        if (args.Length < 2 || !long.TryParse(args[0], out handle) || !uint.TryParse(args[1], out owner)) return 2;
        IntPtr hwnd = new IntPtr(handle);
        uint actualOwner;
        GetWindowThreadProcessId(hwnd, out actualOwner);
        if (!IsWindow(hwnd) || actualOwner != owner) return 3;
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        if (args.Length > 2 && args[2] == "inspect") { Report(hwnd, null); return 0; }
        if (args.Length == 7 && args[2] == "position")
        {
            if (!IsDesktopHost(GetParent(hwnd))) return 4;
            Move(hwnd, int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]), int.Parse(args[6]));
            Report(hwnd, null);
            return 0;
        }
        object gate = new object();
        var commands = new Thread(delegate() {
            try
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    string[] parts = line.Split(' ');
                    int x, y, width, height;
                    if (parts.Length != 5 || parts[0] != "bounds" ||
                        !int.TryParse(parts[1], out x) || !int.TryParse(parts[2], out y) ||
                        !int.TryParse(parts[3], out width) || !int.TryParse(parts[4], out height) ||
                        width < 1 || height < 1 || width > 32768 || height > 32768) continue;
                    lock (gate)
                    {
                        uint currentOwner;
                        GetWindowThreadProcessId(hwnd, out currentOwner);
                        if (currentOwner != owner || !IsDesktopHost(GetParent(hwnd))) continue;
                        Move(hwnd, x, y, width, height);
                        Report(hwnd, null);
                    }
                }
            }
            catch (Exception) { }
        });
        commands.IsBackground = true;
        commands.Start();
        IntPtr reportedParent = new IntPtr(-1);
        string reportedError = null;
        while (IsWindow(hwnd))
        {
            GetWindowThreadProcessId(hwnd, out actualOwner);
            if (actualOwner != owner) return 3;
            lock (gate)
            {
                string error = null;
                IntPtr parent = GetParent(hwnd);
                if (!IsDesktopHost(parent) || (Style(hwnd) & WS_CHILD) == 0)
                {
                    IntPtr host = FindDesktopHost();
                    if (host == IntPtr.Zero) error = "Windows desktop host is not ready.";
                    else try { Attach(hwnd, host); } catch (Exception e) { error = e.Message; }
                }
                parent = GetParent(hwnd);
                if (parent != reportedParent || error != reportedError)
                {
                    Report(hwnd, error);
                    reportedParent = parent;
                    reportedError = error;
                }
            }
            Thread.Sleep(1000);
        }
        return 0;
    }
}
