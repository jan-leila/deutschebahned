let
  sources = import ./npins;
  pebble = import sources."pebble.nix";
  pkgs = import sources.nixpkgs { };
in
pebble.pebbleEnv {
  emulatorTarget = "basalt";
  # sdl3: pebble-qemu needs it to start the emulator.
  # gcc: waf's configure step and the host-side C tests (test/c) want a host compiler.
  # chromium: headless test of the settings page. jq: emulator test scripts.
  packages = [ pkgs.sdl3 pkgs.gcc pkgs.chromium pkgs.jq ];
  shellHook = ''
    unset LD_LIBRARY_PATH
    # the gcc wrapper exports CC/CXX, which would override the ARM cross compiler
    unset CC CXX
    [ -e ~/.local/share/pebble-sdk/SDKs/4.9.169 ] \
      || echo "Hint: run 'pebble sdk install 4.9.169' (newer SDKs need pebble-tool >= 5.1)"
  '';
}
