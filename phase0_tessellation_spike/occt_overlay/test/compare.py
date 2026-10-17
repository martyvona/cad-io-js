# usage: python3 compare.py a.txt b.txt -- per case: segment structure and max pole difference (abs and relative to pole size)
import sys, collections
def load(p):
    segs, poles, summ = {}, collections.defaultdict(list), {}
    for l in open(p):
        w = l.split()
        if w[0] == 'case': segs[(int(w[1]), int(w[3]))] = (int(w[5]), float(w[7]), float(w[8]), float(w[10]), float(w[11]))
        elif w[0] == 'pole': poles[(int(w[1]), int(w[2]))].append([float(x) for x in w[4:]])
        elif w[0] == 'summary': summ[int(w[2])] = ' '.join(w[3:])
    return segs, poles, summ
A, B = load(sys.argv[1]), load(sys.argv[2])
for c in sorted(A[2]):
    ka = sorted(k for k in A[0] if k[0] == c); kb = sorted(k for k in B[0] if k[0] == c)
    same = ka == kb and all(A[0][k][:3] == B[0][k][:3] for k in ka)
    d = r = 0.0; identical = same
    if same:
        for k in ka:
            for pa, pb in zip(A[1][k], B[1][k]):
                for x, y in zip(pa, pb):
                    identical &= x == y; d = max(d, abs(x - y)); r = max(r, abs(x - y) / max(1.0, abs(x)))
    print(f'case {c}: segments/degrees/params same={same} bit-identical={identical} maxPoleDiff={d:.2e} rel={r:.2e} | {A[2][c]} || {B[2][c]}')
