import math
def rtri(pts,r):
    n=len(pts);d=''
    for i in range(n):
        p0=pts[i-1];p1=pts[i];p2=pts[(i+1)%n]
        def toward(a,b,t):
            L=math.dist(a,b);return (a[0]+(b[0]-a[0])*t/L,a[1]+(b[1]-a[1])*t/L)
        a=toward(p1,p0,r);b=toward(p1,p2,r)
        d+=('M' if i==0 else 'L')+f'{a[0]:.1f},{a[1]:.1f} Q{p1[0]},{p1[1]} {b[0]:.1f},{b[1]:.1f} '
    return d+'Z'
T=[(380,290),(380,734),(800,512)]
TP=rtri(T,95)
DEFS='''<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a8cff"/><stop offset="1" stop-color="#3b24b8"/></linearGradient>
<linearGradient id="bgd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4b36c9"/><stop offset="1" stop-color="#150c55"/></linearGradient>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>
<linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cfc6ff"/></linearGradient>
<linearGradient id="gface" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".5" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#cfe9ff" stop-opacity=".45"/></linearGradient>
<linearGradient id="gedge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#9fe8ff"/></linearGradient>
<linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7ab8"/><stop offset=".55" stop-color="#8a5cff"/><stop offset="1" stop-color="#3a7bff"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
<filter id="b2" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="60"/></filter>
<filter id="b9" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>'''
def lerp(c1,c2,t): return '#%02x%02x%02x'%tuple(round(a+(b-a)*t) for a,b in zip(c1,c2))
def hexrgb(h): return tuple(int(h[i:i+2],16) for i in (1,3,5))
def extrude(c_back,c_front,depth,dx=0,dy=1,step=3):
    s='';n=depth//step
    for i in range(n,0,-1):
        c=lerp(hexrgb(c_front),hexrgb(c_back),i/n)
        s+=f'<path d="{TP}" fill="{c}" stroke="{c}" stroke-width="2" transform="translate({dx*i*step:.1f},{dy*i*step})"/>'
    return s
# ---- Layers per variant: bg(w,h,rx,off) ; body ; face (1024 space)
def bg_std(dark,blobs):
    def f(w,h,rx):
        sq=f'<rect x="{0 if rx==0 else 64}" y="{0 if rx==0 else 64}" width="{w if rx==0 else w-128}" height="{h if rx==0 else h-128}" rx="{rx}" fill="url(#{"bgd" if dark else "bg"})"/>'
        return sq
    return f
V={}
# A1 Glas: Glas-Play ueber farbigem Leuchten
V['a1-glas']=dict(dark=True,
 bg_extra='<circle cx="400" cy="640" r="190" fill="#ff5fb0" opacity=".85" filter="url(#b2)"/><circle cx="660" cy="400" r="200" fill="#3fd0ff" opacity=".8" filter="url(#b2)"/>',
 body=extrude('#3b2aa0','#8f7cff',60,0,1,4)+f'<path d="{TP}" fill="#fff" opacity=".18" transform="translate(0,64)" filter="url(#b9)"/>',
 face=f'<path d="{TP}" fill="url(#gface)"/><path d="{TP}" fill="none" stroke="url(#gedge)" stroke-width="7"/>')
# A2 Deep 3D: dicke Extrusion, Kunststoff
V['a2-deep3d']=dict(dark=False,
 bg_extra='<ellipse cx="512" cy="900" rx="330" ry="60" fill="#150c55" opacity=".6" filter="url(#b)"/>',
 body=f'<path d="{TP}" fill="#150c55" opacity=".55" transform="translate(30,150)" filter="url(#b)"/>'+extrude('#2a1a8a','#7b69ee',120,0.35,1,4),
 face=f'<path d="{TP}" fill="url(#face)"/><path d="{TP}" fill="none" stroke="#fff" stroke-width="5" opacity=".9"/>')
# A3 Kombi: Glasplatte + farbiger Koerper + Glas-Deckel
V['a3-kombi']=dict(dark=True,
 bg_extra='<circle cx="330" cy="700" r="200" fill="#ff5fb0" opacity=".7" filter="url(#b2)"/><circle cx="740" cy="330" r="200" fill="#3fd0ff" opacity=".28" filter="url(#b2)"/><rect x="170" y="170" width="684" height="684" rx="150" fill="#fff" opacity=".07" stroke="#fff" stroke-opacity=".35" stroke-width="4"/><path d="M170 320 Q170 170 320 170 H704 Q854 170 854 320 V380 Q512 300 170 400Z" fill="#fff" opacity=".08"/>',
 body=f'<path d="{TP}" fill="#000" opacity=".4" transform="translate(0,120)" filter="url(#b)"/>'+extrude('#ff5fb0','#7b5cff',90,0,1,3),
 face=f'<path d="{TP}" fill="url(#gface)"/><path d="{TP}" fill="none" stroke="url(#gedge)" stroke-width="7"/>')
def wrap(w,h,inner): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">{DEFS}{inner}</svg>'
def bgrect(v,w,h,rx,x=0,y=0):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="url(#{"bgd" if v["dark"] else "bg"})"/>'
for k,v in V.items():
    # macOS (Squircle mit Rand)
    clip='<clipPath id="c"><rect x="64" y="64" width="896" height="896" rx="210"/></clipPath>'
    mac=(f'<rect x="64" y="84" width="896" height="896" rx="210" fill="#0c0630" opacity=".5" filter="url(#b2)"/>'+bgrect(v,896,896,210,64,64)+clip+
      f'<g clip-path="url(#c)"><ellipse cx="512" cy="40" rx="620" ry="400" fill="url(#gloss)"/>{v["bg_extra"]}</g>'+
      '<rect x="68" y="68" width="888" height="888" rx="206" fill="none" stroke="url(#rim)" stroke-width="8"/>'+
      f'<g transform="translate(512 512) scale(.97) translate(-512 -512)">{v["body"]}{v["face"]}</g>')
    open(f'mac-{k}.svg','w').write(wrap(1024,1024,mac))
    # iPad/iOS: vollflaechig, keine Rundung (iOS maskiert selbst), keine Transparenz
    ios=(bgrect(v,1024,1024,0)+f'<ellipse cx="512" cy="0" rx="700" ry="440" fill="url(#gloss)"/>{v["bg_extra"]}'+
      f'{v["body"]}{v["face"]}')
    open(f'ipad-{k}.svg','w').write(wrap(1024,1024,ios))
    # tvOS: 1280x768, 3 Ebenen (Parallax): hinten / mitte / vorne
    tf='translate(640 384) scale(.8) translate(-512 -512)'
    L0=bgrect(v,1280,768,0)+f'<g transform="{tf}">{v["bg_extra"]}</g><ellipse cx="640" cy="0" rx="900" ry="300" fill="url(#gloss)"/>'
    L1=f'<g transform="{tf}">{v["body"]}</g>'
    L2=f'<g transform="{tf}">{v["face"]}</g>'
    open(f'tv-{k}.svg','w').write(wrap(1280,768,f'<clipPath id="r"><rect width="1280" height="768" rx="64"/></clipPath><g clip-path="url(#r)">{L0}{L1}{L2}</g>'))
    for n,L in (('1-hinten',L0),('2-mitte',L1),('3-vorne',L2)):
        open(f'tv-{k}-ebene{n}.svg','w').write(wrap(1280,768,L))
# Menueleiste: Template (nur Alpha, schwarz). 3 Stufen = Tiefe
def menubar(style):
    P=rtri([(9,6),(9,30),(30,18)],4)
    if style=='tiefe':
        s=''.join(f'<path d="{P}" transform="translate(0,{i*0.5})" fill="#000" opacity=".55"/>' for i in range(1,4))
        s+=f'<path d="{P}" fill="#000"/><path d="M11 9 L11 14 L22 11Z" fill="#fff" opacity=".0"/>'
        return s
    if style=='glas':
        return f'<path d="{P}" fill="#000" opacity=".28"/><path d="{P}" fill="none" stroke="#000" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 9.5 L12 13 L20 10.5Z" fill="#000" opacity=".9"/>'
for st in ('tiefe','glas'):
    open(f'menubar-{st}Template.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">{menubar(st)}</svg>')
