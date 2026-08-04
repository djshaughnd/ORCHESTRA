from PIL import Image, ImageDraw, ImageFont
import math

S = 1024
img = Image.new("RGBA", (S, S), (0,0,0,0))
d = ImageDraw.Draw(img)

# rounded-square background (macOS-ish), inset a touch
m = 90
r = 210
# vertical gradient bg
bg = Image.new("RGB", (S, S))
for y in range(S):
    t = y / S
    c = (int(22+ t*6), int(24+ t*6), int(30+ t*8))  # dark charcoal, subtle
    for x in range(S):
        pass
# faster gradient with numpy-free approach: paint per-row
grad = Image.new("RGB", (1, S))
for y in range(S):
    t = y/S
    grad.putpixel((0,y), (int(20+t*10), int(22+t*12), int(30+t*16)))
grad = grad.resize((S,S))
mask = Image.new("L",(S,S),0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([m,m,S-m,S-m], radius=r, fill=255)
img.paste(grad,(0,0),mask)

# subtle inner border
bd = ImageDraw.Draw(img)
bd.rounded_rectangle([m,m,S-m,S-m], radius=r, outline=(255,255,255,26), width=4)

# EQ / orchestra bars — 7 bars, green->teal gradient, varied heights
bars = [0.42, 0.68, 0.95, 0.72, 1.0, 0.6, 0.5]
n = len(bars)
area_w = S - 2*(m+90)
gap = 26
bw = (area_w - gap*(n-1)) / n
cx0 = m+90
base_y = S*0.70            # bottom of bars
max_h = S*0.42
def lerp(a,b,t): return int(a+(b-a)*t)
for i,h in enumerate(bars):
    x0 = cx0 + i*(bw+gap)
    x1 = x0+bw
    bh = h*max_h
    y0 = base_y - bh
    t = i/(n-1)
    col = (lerp(52,48,t), lerp(199,208,t), lerp(89,192,t), 255)  # #34c759 -> teal
    bd.rounded_rectangle([x0,y0,x1,base_y], radius=int(bw/2), fill=col)

# red record dot, top-right of the bar cluster
rr = 58
rcx, rcy = S-m-150, m+180
bd.ellipse([rcx-rr,rcy-rr,rcx+rr,rcy+rr], fill=(255,69,58,255))

# wordmark
def load_font(size):
    for p in ["/System/Library/Fonts/HelveticaNeue.ttc",
              "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/Library/Fonts/Arial Bold.ttf"]:
        try: return ImageFont.truetype(p, size)
        except: continue
    return ImageFont.load_default()
f = load_font(96)
txt = "ORCHESTRA"
# letter-spacing
spacing = 14
w = sum(d.textlength(ch,font=f)+spacing for ch in txt)-spacing
x = (S-w)/2
ty = S*0.74
for ch in txt:
    bd.text((x,ty), ch, font=f, fill=(240,240,242,255))
    x += d.textlength(ch,font=f)+spacing

img.save("orchestra_1024.png")
print("saved orchestra_1024.png")
