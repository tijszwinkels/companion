"""Two disposable GTK fields for the opt-in live delivery test."""
import json
import os
import sys

import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk

directory = sys.argv[1]
app = Gtk.Application(application_id="org.companion.InputTest", flags=Gio.ApplicationFlags.NON_UNIQUE)
buffers = {}


def activate(application):
    for name in ("A", "B"):
        window = Gtk.ApplicationWindow(application=application, title=f"Companion test {name} {directory}")
        window.set_default_size(640, 360)
        entry = Gtk.TextView()
        entry.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        buffers[name] = entry.get_buffer()
        window.set_child(entry)
        window.present()
        entry.grab_focus()

    def save():
        texts = {name: buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)
                 for name, buffer in buffers.items()}
        temporary = os.path.join(directory, "text.tmp")
        with open(temporary, "w") as file:
            json.dump(texts, file)
        os.replace(temporary, os.path.join(directory, "text.json"))
        return True

    GLib.timeout_add(50, save)


app.connect("activate", activate)
app.run([])
