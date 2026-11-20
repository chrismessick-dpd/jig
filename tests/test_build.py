"""Tests for tools/build.py's parsing and checks (no arduino-cli needed).

    python tests/test_build.py
"""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "tools"))
import build  # noqa: E402


class Messages(unittest.TestCase):
    roots = [(pathlib.Path("/tmp/jig-x/sketch"), ""), (pathlib.Path("/data/board"), "board")]

    def test_gcc_lines(self):
        log = ("/tmp/jig-x/sketch/sketch.ino: In function 'void setup()':\n"
               "/tmp/jig-x/sketch/sketch.ino:2:11: error: 'ledPin' was not declared in this scope\n"
               "    2 |   pinMode(ledPin, OUTPUT);\n"
               "/data/board/hardware/acme/stm32/libraries/Lib/src/lib.cpp:40:3: warning: unused variable 'x' [-Wunused-variable]\n"
               "/tmp/jig-x/sketch/pins.h:5: note: macro defined here\n"
               "/home/u/.arduino15/packages/acme/hardware/stm32/1.0.0/cores/arduino/main.cpp:9:1: fatal error: Missing.h: No such file or directory\n")
        m = build.parse_messages(log, self.roots)
        self.assertEqual([(x["file"], x["line"], x["col"], x["severity"]) for x in m], [
            ("sketch.ino", 2, 11, "error"),
            ("board/hardware/acme/stm32/libraries/Lib/src/lib.cpp", 40, 3, "warning"),
            ("pins.h", 5, None, "note"),
            ("acme/hardware/stm32/1.0.0/cores/arduino/main.cpp", 9, 1, "error")])

    def test_linker_and_overflow(self):
        log = ("/tmp/jig-x/build/sketch.ino.cpp.o: in function `loop':\n"
               "/tmp/jig-x/sketch/sketch.ino:(.text.loop+0x4): undefined reference to `blink()'\n"
               "ld: region `FLASH' overflowed by 1204 bytes\n")
        m = build.parse_messages(log, self.roots)
        self.assertEqual(m[0]["file"], "sketch.ino")
        self.assertIn("undefined reference", m[0]["text"])
        self.assertEqual(m[1]["text"], "The firmware is 1204 bytes too big for FLASH")

    def test_duplicates_dropped(self):
        line = "/tmp/jig-x/sketch/a.ino:1:1: error: x\n"
        self.assertEqual(len(build.parse_messages(line * 3, self.roots)), 1)


class Sketch(unittest.TestCase):
    def make(self, names):
        d = pathlib.Path(tempfile.mkdtemp()) / "p"
        (d / "sketch").mkdir(parents=True)
        for n in names:
            (d / "sketch" / n).write_text("x", encoding="utf-8")
        return d

    def test_one_ino(self):
        self.assertEqual(build.sketch_files(self.make(["A.ino", "b.h"]), None), ("A.ino", ["A.ino", "b.h"]))

    def test_main_needed_with_two(self):
        with self.assertRaises(ValueError):
            build.sketch_files(self.make(["A.ino", "B.ino"]), None)
        self.assertEqual(build.sketch_files(self.make(["A.ino", "B.ino"]), "B.ino")[0], "B.ino")

    def test_bad_names(self):
        with self.assertRaises(ValueError):
            build.sketch_files(self.make(["A.ino", "notes.txt"]), None)
        with self.assertRaises(ValueError):
            build.sketch_files(self.make([]), None)

    def test_unknown_board_writes_a_failed_result(self):
        data = pathlib.Path(tempfile.mkdtemp())
        (data / "projects" / "p-1").mkdir(parents=True)
        (data / "boards.json").write_text('{"core": {"id": "a:b", "version": "1"}, "boards": {}}', encoding="utf-8")
        (data / "projects" / "p-1" / "project.json").write_text('{"name": "P", "board": "nope"}', encoding="utf-8")
        out = pathlib.Path(tempfile.mkdtemp())
        r = build.build(data, "p-1", "abc1234", out, "arduino-cli", None)
        self.assertFalse(r["ok"])
        self.assertIn("no board", r["messages"][0]["text"])
        self.assertTrue((out / "p-1" / "abc1234.json").is_file())


if __name__ == "__main__":
    unittest.main()
