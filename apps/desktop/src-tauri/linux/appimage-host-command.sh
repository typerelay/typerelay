#!/bin/sh
set -eu

command=${0##*/}
# These desktop helpers use the host's GLib and GTK modules.
unset LD_LIBRARY_PATH GIO_MODULE_DIR GI_TYPELIB_PATH GTK_PATH GTK_DATA_PREFIX GTK_EXE_PREFIX
unset GSETTINGS_SCHEMA_DIR GTK_IM_MODULE_FILE GDK_PIXBUF_MODULE_FILE
if [ "$command" = update-desktop-database ] && [ ! -x "/usr/bin/$command" ]; then
    exit 0
fi
exec "/usr/bin/$command" "$@"
