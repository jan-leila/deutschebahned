import os.path
import subprocess

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')

def configure(ctx):
    ctx.load('pebble_sdk')
    # The SDK names the bundle after the checkout directory; pin it so scripts can rely on build/bus-watch.pbw.
    ctx.env.BUNDLE_NAME = 'bus-watch.pbw'

def build(ctx):
    # src/pkjs/config-page.js is generated from config/ (and not committed); regenerate it before the JS is globbed.
    subprocess.check_call(['node', os.path.join(ctx.path.abspath(), 'tools', 'build-config.js')])
    ctx.load('pebble_sdk')
    binaries = []
    cached_env = ctx.env
    for p in ctx.env.TARGET_PLATFORMS:
        ctx.set_env(ctx.all_envs[p])
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'), target=app_elf, bin_type='app')
        binaries.append({'platform': p, 'app_elf': app_elf})
    ctx.set_env(cached_env)
    ctx.set_group('bundle')
    ctx.pbl_bundle(binaries=binaries,
                   js=ctx.path.ant_glob(['src/pkjs/**/*.js', 'src/pkjs/**/*.json', 'src/common/**/*.js']),
                   js_entry_file=os.environ.get('PKJS_ENTRY', 'src/pkjs/index.js'))
