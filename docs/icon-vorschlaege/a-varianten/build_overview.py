import base64
def u(f): return 'data:image/svg+xml;base64,'+base64.b64encode(open(f,'rb').read()).decode()
vs=[('a1-glas','A1 · Glas'),('a2-deep3d','A2 · Deep 3D'),('a3-kombi','A3 · Kombi')]
h='''<!doctype html><meta charset=utf-8><title>Icon-Varianten A</title><style>
body{font:14px -apple-system,sans-serif;background:#e9e9ef;margin:20px;color:#222}
.row{display:flex;flex-wrap:wrap;gap:28px;align-items:center;background:#fff;border-radius:16px;padding:20px;margin-bottom:16px}
h3{width:90px;margin:0}.row img{display:block}
.mb{display:flex;gap:10px;padding:6px 14px;border-radius:8px;align-items:center}
.l{background:#ececf0}.d{background:#2a2a30}.d img{filter:invert(1)}.mb img{width:18px;height:18px}
</style>'''
for k,n in vs:
    h+=f'<div class=row><h3>{n}</h3><img src="{u(f"mac-{k}.svg")}" width=200><img src="{u(f"ipad-{k}.svg")}" width=170 style="border-radius:38px"><img src="{u(f"tv-{k}.svg")}" width=290 style="border-radius:12px"><img src="{u(f"mac-{k}.svg")}" width=64><img src="{u(f"mac-{k}.svg")}" width=32></div>'
h+='<div class=row><h3>Menüzeile</h3>'
for s in ('tiefe','glas'):
    m=u(f'menubar-{s}Template.svg')
    h+=f'<div><div class="mb l"><img src="{m}"><span>{s} (hell)</span></div><br><div class="mb d" style="color:#fff"><img src="{m}"><span>{s} (dunkel)</span></div></div><img src="{m}" width=108 style="background:#ddd">'
open('uebersicht.html','w').write(h+'</div>')
