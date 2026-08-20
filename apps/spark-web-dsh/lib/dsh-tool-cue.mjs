var $x = Object.defineProperty;
var En = (e, t) => {
  for (var n in t) $x(e, n, { get: t[n], enumerable: !0 });
};
import { defineTool as Vv } from "@deepseek-ai/dsh-tools";
import ts from "@deepseek-ai/schemastery";
import { execFileSync as av } from "node:child_process";
import { realpath as Hh } from "node:fs/promises";
import * as $t from "node:path";
var l = {};
En(l, {
  Assign: () => Tx,
  Clone: () => Sr,
  Create: () => Py,
  Discard: () => Ay,
  Metrics: () => ht,
  Update: () => My,
});
var ht = { assign: 0, create: 0, clone: 0, discard: 0, update: 0 };
function Tx(e, t) {
  return ((ht.assign += 1), { ...e, ...t });
}
var u = {};
En(u, {
  Counted: () => Jx,
  Entries: () => Hx,
  EntriesRegExp: () => zx,
  Every: () => qx,
  EveryAll: () => Ux,
  GraphemeCount: () => Nx,
  HasPropertyKey: () => Gx,
  IsArray: () => Tr,
  IsBigInt: () => $r,
  IsBoolean: () => xu,
  IsClassInstance: () => Lx,
  IsConstructor: () => Rx,
  IsDeepEqual: () => as,
  IsEqual: () => Q,
  IsFunction: () => yu,
  IsGreaterEqualThan: () => Iu,
  IsGreaterThan: () => Ax,
  IsInteger: () => is,
  IsLessEqualThan: () => bu,
  IsLessThan: () => Mx,
  IsMaxLength: () => Dx,
  IsMinLength: () => Fx,
  IsMultipleOf: () => jx,
  IsNull: () => So,
  IsNumber: () => ko,
  IsObject: () => vr,
  IsObjectNotArray: () => Ox,
  IsString: () => _o,
  IsSymbol: () => Px,
  IsUndefined: () => ss,
  IsUnsafePropertyKey: () => Eu,
  IsValueLike: () => Cu,
  Keys: () => vo,
  ShiftLeft: () => Ro,
  Some: () => Kx,
  SomeAll: () => Bx,
  Symbols: () => Wx,
  Values: () => Vx,
});
function wn(e, t, n) {
  return e >= t && e <= n;
}
function mu(e) {
  return e === 8205;
}
function vx(e) {
  return wn(e, 55296, 56319);
}
function uu(e) {
  return wn(e, 127462, 127487);
}
function pu(e) {
  return wn(e, 65024, 65039);
}
function du(e) {
  return wn(e, 768, 879) || wn(e, 6832, 6911) || wn(e, 7616, 7679) || wn(e, 65056, 65071);
}
function To(e) {
  return e > 65535 ? 2 : 1;
}
function cu(e, t) {
  for (; t < e.length;) {
    let n = e.codePointAt(t);
    if (du(n) || pu(n)) t += To(n);
    else break;
  }
  return t;
}
function os(e, t) {
  let n = e.codePointAt(t),
    r = t + To(n);
  for (r = cu(e, r); r < e.length - 1 && mu(e.codePointAt(r));) {
    let o = e.codePointAt(r + 1);
    ((r += 1 + To(o)), (r = cu(e, r)));
  }
  return (uu(n) && r < e.length && uu(e.codePointAt(r)) && (r += To(e.codePointAt(r))), r);
}
function lu(e) {
  return vx(e) || du(e) || pu(e) || mu(e);
}
function fu(e) {
  let t = 0,
    n = 0;
  for (; n < e.length;) ((n = os(e, n)), t++);
  return t;
}
function Sx(e, t) {
  if (t === 0) return !0;
  let n = 0,
    r = 0;
  for (; r < e.length;) if (((r = os(e, r)), n++, n >= t)) return !0;
  return !1;
}
function kx(e, t) {
  let n = 0,
    r = 0;
  for (; r < e.length;) if (((r = os(e, r)), n++, n > t)) return !1;
  return !0;
}
function gu(e, t) {
  if (t === 0) return !0;
  let n = 0;
  for (; n < e.length;) {
    if (lu(e.charCodeAt(n))) return Sx(e, t);
    if ((n++, n >= t)) return !0;
  }
  return !1;
}
function hu(e, t) {
  let n = 0;
  for (; n < e.length;) {
    if (lu(e.charCodeAt(n))) return kx(e, t);
    if ((n++, n > t)) return !1;
  }
  return !0;
}
function Tr(e) {
  return Array.isArray(e);
}
function $r(e) {
  return Q(typeof e, "bigint");
}
function xu(e) {
  return Q(typeof e, "boolean");
}
function Rx(e) {
  if (ss(e) || !yu(e)) return !1;
  let t = Function.prototype.toString.call(e);
  return !!(/^class\s/.test(t) || /\[native code\]/.test(t));
}
function yu(e) {
  return Q(typeof e, "function");
}
function is(e) {
  return Number.isInteger(e);
}
function So(e) {
  return Q(e, null);
}
function ko(e) {
  return Number.isFinite(e);
}
function Ox(e) {
  return vr(e) && !Tr(e);
}
function vr(e) {
  return Q(typeof e, "object") && !So(e);
}
function _o(e) {
  return Q(typeof e, "string");
}
function Px(e) {
  return Q(typeof e, "symbol");
}
function ss(e) {
  return Q(e, void 0);
}
function Q(e, t) {
  return e === t;
}
function Ax(e, t) {
  return e > t;
}
function Mx(e, t) {
  return e < t;
}
function bu(e, t) {
  return e <= t;
}
function Iu(e, t) {
  return e >= t;
}
function jx(e, t) {
  if ($r(e) || $r(t)) return BigInt(e) % BigInt(t) === 0n;
  let n = 1e-10;
  if (!ko(e) || (is(e) && (1 / t) % 1 === 0)) return !0;
  let r = e % t;
  return Math.min(Math.abs(r), Math.abs(r - t), Math.abs(r + t)) < n;
}
function Lx(e) {
  if (!vr(e)) return !1;
  let t = globalThis.Object.getPrototypeOf(e);
  return So(t)
    ? !1
    : Q(typeof t.constructor, "function") &&
        !(Q(t.constructor, globalThis.Object) || Q(t.constructor.name, "Object"));
}
function Cu(e) {
  return $r(e) || xu(e) || So(e) || ko(e) || _o(e) || ss(e);
}
function Nx(e) {
  return fu(e);
}
function Dx(e, t) {
  return hu(e, t);
}
function Fx(e, t) {
  return gu(e, t);
}
function qx(e, t, n) {
  for (let r = t; r < e.length; r++) if (!n(e[r], r)) return !1;
  return !0;
}
function Ux(e, t, n) {
  let r = !0;
  for (let o = t; o < e.length; o++) n(e[o], o) || (r = !1);
  return r;
}
function Kx(e, t) {
  for (let n = 0; n < e.length; n++) if (t(e[n], n)) return !0;
  return !1;
}
function Bx(e, t) {
  let n = !1;
  for (let r = 0; r < e.length; r++) t(e[r], r) && (n = !0);
  return n;
}
function Jx(e, t) {
  return e.reduce((n, r, o) => (t(r, o) ? ++n : n), 0);
}
function Ro(e, t, n) {
  return Q(e.length, 0) ? n() : t(e[0], e.slice(1));
}
function Eu(e) {
  return Q(e, "__proto__") || Q(e, "constructor") || Q(e, "prototype");
}
function Gx(e, t) {
  return Eu(t) ? Object.prototype.hasOwnProperty.call(e, t) : t in e;
}
function zx(e) {
  return vo(e).map((t) => [new RegExp(`^${t}$`), e[t]]);
}
function Hx(e) {
  return Object.entries(e);
}
function vo(e) {
  return Object.getOwnPropertyNames(e);
}
function Wx(e) {
  return Object.getOwnPropertySymbols(e);
}
function Vx(e) {
  return Object.values(e);
}
function Xx(e, t) {
  if (!vr(t)) return !1;
  let n = vo(e);
  return Q(n.length, vo(t).length) && n.every((r) => as(e[r], t[r]));
}
function Yx(e, t) {
  return Tr(t) && Q(e.length, t.length) && e.every((n, r) => as(e[r], t[r]));
}
function as(e, t) {
  return Tr(e) ? Yx(e, t) : vr(e) ? Xx(e, t) : Q(e, t);
}
var en = {};
En(en, {
  IsBigInt64Array: () => dy,
  IsBigUint64Array: () => ly,
  IsBoolean: () => Zx,
  IsDate: () => gy,
  IsFloat32Array: () => my,
  IsFloat64Array: () => py,
  IsInt16Array: () => sy,
  IsInt32Array: () => uy,
  IsInt8Array: () => ry,
  IsMap: () => xy,
  IsNumber: () => ey,
  IsRegExp: () => fy,
  IsSet: () => hy,
  IsString: () => ty,
  IsTypeArray: () => ny,
  IsUint16Array: () => ay,
  IsUint32Array: () => cy,
  IsUint8Array: () => oy,
  IsUint8ClampedArray: () => iy,
});
function Zx(e) {
  return e instanceof Boolean;
}
function ey(e) {
  return e instanceof Number;
}
function ty(e) {
  return e instanceof String;
}
function ny(e) {
  return globalThis.ArrayBuffer.isView(e);
}
function ry(e) {
  return e instanceof globalThis.Int8Array;
}
function oy(e) {
  return e instanceof globalThis.Uint8Array;
}
function iy(e) {
  return e instanceof globalThis.Uint8ClampedArray;
}
function sy(e) {
  return e instanceof globalThis.Int16Array;
}
function ay(e) {
  return e instanceof globalThis.Uint16Array;
}
function uy(e) {
  return e instanceof globalThis.Int32Array;
}
function cy(e) {
  return e instanceof globalThis.Uint32Array;
}
function my(e) {
  return e instanceof globalThis.Float32Array;
}
function py(e) {
  return e instanceof globalThis.Float64Array;
}
function dy(e) {
  return e instanceof globalThis.BigInt64Array;
}
function ly(e) {
  return e instanceof globalThis.BigUint64Array;
}
function fy(e) {
  return e instanceof globalThis.RegExp;
}
function gy(e) {
  return e instanceof globalThis.Date;
}
function hy(e) {
  return e instanceof globalThis.Set;
}
function xy(e) {
  return e instanceof globalThis.Map;
}
function by(e) {
  return u.HasPropertyKey(e, "~kind") || u.HasPropertyKey(e, "~unsafe");
}
function Iy(e) {
  let t = {};
  for (let n of u.Keys(e)) {
    if (u.IsUnsafePropertyKey(n)) continue;
    let r = Object.getOwnPropertyDescriptor(e, n);
    ((r.value = $n(r.value)),
      u.IsEqual(r.enumerable, !0) ? (t[n] = r.value) : Object.defineProperty(t, n, r));
  }
  return t;
}
function Cy(e) {
  let t = {};
  for (let n of u.Keys(e)) u.IsUnsafePropertyKey(n) || (t[n] = $n(e[n]));
  for (let n of u.Symbols(e)) t[n] = $n(e[n]);
  return t;
}
function Ey(e) {
  return u.IsClassInstance(e) ? e : by(e) ? Iy(e) : Cy(e);
}
function wy(e) {
  return e.map((t) => $n(t));
}
function $y(e) {
  return e.slice();
}
function Ty(e) {
  return new RegExp(e.source, e.flags);
}
function vy(e) {
  return new Map($n([...e.entries()]));
}
function Sy(e) {
  return new Set($n([...e.values()]));
}
function $n(e) {
  return en.IsTypeArray(e)
    ? $y(e)
    : en.IsRegExp(e)
      ? Ty(e)
      : en.IsMap(e)
        ? vy(e)
        : en.IsSet(e)
          ? Sy(e)
          : u.IsArray(e)
            ? wy(e)
            : u.IsObject(e)
              ? Ey(e)
              : e;
}
function Sr(e) {
  return ((ht.clone += 1), $n(e));
}
var Gt = {};
En(Gt, { Get: () => Ry, Reset: () => ky, Set: () => _y });
var vt = {
  immutableTypes: !1,
  maxErrors: 8,
  maxInstantiationCount: 128,
  useAcceleration: !0,
  exactOptionalPropertyTypes: !1,
  enumerableKind: !1,
  correctiveParse: !1,
  unionPrioritySort: !0,
};
function ky() {
  ((vt.immutableTypes = !1),
    (vt.maxErrors = 8),
    (vt.maxInstantiationCount = 128),
    (vt.useAcceleration = !0),
    (vt.exactOptionalPropertyTypes = !1),
    (vt.enumerableKind = !1),
    (vt.correctiveParse = !1),
    (vt.unionPrioritySort = !0));
}
function _y(e) {
  for (let t of u.Keys(e)) {
    let n = e[t];
    n !== void 0 && Object.defineProperty(vt, t, { value: n });
  }
}
function Ry() {
  return vt;
}
function Oy(e, t) {
  for (let n of Object.keys(t))
    Object.defineProperty(e, n, { configurable: !0, writable: !0, enumerable: !1, value: t[n] });
  return e;
}
function wu(e, t) {
  return { ...e, ...t };
}
function Py(e, t, n = {}) {
  ht.create += 1;
  let r = Gt.Get(),
    o = wu(t, n),
    i = r.enumerableKind ? wu(o, e) : Oy(o, e);
  return r.immutableTypes ? Object.freeze(i) : i;
}
function Ay(e, t) {
  ht.discard += 1;
  let n = {};
  for (let r of u.Keys(e)) {
    if (t.includes(r)) continue;
    let o = Object.getOwnPropertyDescriptor(e, r);
    ((o.value = Sr(o.value)), Object.defineProperty(n, r, o));
  }
  return n;
}
function My(e, t, n) {
  ht.update += 1;
  let r = Gt.Get(),
    o = Sr(e);
  for (let i of Object.keys(t))
    Object.defineProperty(o, i, {
      configurable: !0,
      writable: !0,
      enumerable: r.enumerableKind,
      value: t[i],
    });
  for (let i of Object.keys(n))
    Object.defineProperty(o, i, { configurable: !0, enumerable: !0, writable: !0, value: n[i] });
  return o;
}
function R(e, t) {
  return u.IsObject(e) && u.HasPropertyKey(e, "~kind") && u.IsEqual(e["~kind"], t);
}
function Se(e) {
  return u.IsObject(e);
}
function A(e, t, n) {
  return l.Create(
    { "~kind": "Deferred" },
    { type: "deferred", action: e, parameters: t, options: n },
    {},
  );
}
function tn(e) {
  return R(e, "Deferred");
}
function jy(e) {
  return l.Update(e, { "~readonly": !0 }, {});
}
function kr(e, t) {
  return l.Update(jy(e), {}, t);
}
function $u(e, t, n, r) {
  let o = w(e, t, n);
  return kr(o, r);
}
function Ly(e) {
  return l.Update(e, { "~optional": !0 }, {});
}
function _r(e, t) {
  return l.Update(Ly(e), {}, t);
}
function Tu(e, t, n, r) {
  let o = w(e, t, n);
  return _r(o, r);
}
function st(e, t) {
  return l.Create({ "~kind": "Array" }, { type: "array", items: e }, t);
}
function le(e) {
  return R(e, "Array");
}
function Oo(e) {
  return l.Discard(e, ["~kind", "type", "items"]);
}
function St(e, t, n = {}) {
  return l.Create(
    { "~kind": "Constructor" },
    { type: "constructor", parameters: e, instanceType: t },
    n,
  );
}
function Re(e) {
  return R(e, "Constructor");
}
function vu(e) {
  return l.Discard(e, ["~kind", "type", "parameters", "instanceType"]);
}
function kt(e, t, n = {}) {
  return l.Create({ "~kind": "Function" }, { type: "function", parameters: e, returnType: t }, n);
}
function Oe(e) {
  return R(e, "Function");
}
function Su(e) {
  return l.Discard(e, ["~kind", "type", "parameters", "returnType"]);
}
function zt(e, t) {
  return l.Create({ "~kind": "Ref" }, { $ref: e }, t);
}
function Pe(e) {
  return R(e, "Ref");
}
function nn(e, t) {
  return l.Create({ "~kind": "Generic" }, { type: "generic", parameters: e, expression: t });
}
function Bn(e) {
  return R(e, "Generic");
}
function Jn(e) {
  return l.Create({ "~kind": "Any" }, {}, e);
}
function he(e) {
  return R(e, "Any");
}
var ku = "(?!)";
function oe(e) {
  return l.Create({ "~kind": "Never" }, { not: {} }, e);
}
function xt(e) {
  return R(e, "Never");
}
function _t(e, t = {}) {
  return A("AddOptional", [e], t);
}
function Tn(e, t = {}) {
  return _r(e, t);
}
function _u(e) {
  return Tn(e);
}
function Be(e) {
  return Se(e) && u.HasPropertyKey(e, "~optional");
}
function Ru(e) {
  return u.Keys(e).filter((t) => !Be(e[t]));
}
function Po(e) {
  return u.Keys(e);
}
function Ao(e) {
  return u.Values(e);
}
function N(e, t = {}) {
  let n = Ru(e),
    r = n.length > 0 ? { required: n } : {};
  return l.Create({ "~kind": "Object" }, { type: "object", ...r, properties: e }, t);
}
function te(e) {
  return R(e, "Object");
}
function Ou(e) {
  return l.Discard(e, ["~kind", "type", "properties", "required"]);
}
function je(e) {
  return l.Create({ "~kind": "Unknown" }, {}, e);
}
function Ee(e) {
  return R(e, "Unknown");
}
function Rt(e, t, n) {
  let r = u.Keys(e).reduce((o, i) => ({ ...o, [i]: l.Update(e[i], {}, { $id: i }) }), {});
  return l.Create({ "~kind": "Cyclic" }, { $defs: r, $ref: t }, n);
}
function De(e) {
  return R(e, "Cyclic");
}
function Pu(e) {
  return l.Update(e, { "~unsafe": null }, {});
}
function Mo(e) {
  return u.IsObjectNotArray(e) && u.HasPropertyKey(e, "~unsafe") && u.IsNull(e["~unsafe"]);
}
var Ot = {};
En(Ot, { Match: () => Ny });
function Ny(e, t) {
  return (
    t[e.length]?.(...e) ??
    (() => {
      throw Error("Invalid Arguments");
    })()
  );
}
function Rr(...e) {
  let [t, n] = Ot.Match(e, { 2: (r, o) => [r, o, o], 1: (r) => [r, je(), je()] });
  return l.Create({ "~kind": "Infer" }, { type: "infer", name: t, extends: n }, {});
}
function we(e) {
  return R(e, "Infer");
}
function vn(e, t, n, r = {}) {
  return l.Create({ "~kind": "Dependent" }, { if: e, then: t, else: n }, r);
}
function ye(e) {
  return R(e, "Dependent");
}
function Au(e) {
  return l.Discard(e, ["~kind", "if", "then", "else"]);
}
function Mu(e) {
  return u.IsObjectNotArray(e);
}
function ju(e) {
  return u
    .Keys(e)
    .filter((n) => isNaN(n))
    .reduce((n, r) => [...n, e[r]], []);
}
function Lu(e) {
  return u.IsString(e) || u.IsNumber(e);
}
function Nu(e, t) {
  let n = Mu(e) ? ju(e) : e;
  return l.Create({ "~kind": "Enum" }, { enum: n }, t);
}
function Fe(e) {
  return R(e, "Enum");
}
function Ye(e, t = {}) {
  return l.Create({ "~kind": "Intersect" }, { allOf: e }, t);
}
function V(e) {
  return R(e, "Intersect");
}
function Du(e) {
  return l.Discard(e, ["~kind", "allOf"]);
}
function ke() {
  throw new Error("Unreachable");
}
var Fu;
(function (e) {
  ((e[(e.Array = 0)] = "Array"),
    (e[(e.BigInt = 1)] = "BigInt"),
    (e[(e.Boolean = 2)] = "Boolean"),
    (e[(e.Date = 3)] = "Date"),
    (e[(e.Constructor = 4)] = "Constructor"),
    (e[(e.Function = 5)] = "Function"),
    (e[(e.Null = 6)] = "Null"),
    (e[(e.Number = 7)] = "Number"),
    (e[(e.Object = 8)] = "Object"),
    (e[(e.RegExp = 9)] = "RegExp"),
    (e[(e.String = 10)] = "String"),
    (e[(e.Symbol = 11)] = "Symbol"),
    (e[(e.TypeArray = 12)] = "TypeArray"),
    (e[(e.Undefined = 13)] = "Undefined"));
})(Fu || (Fu = {}));
var g_ = BigInt("14695981039346656037"),
  [h_, x_] = [BigInt("1099511628211"), BigInt("18446744073709551616")],
  y_ = Array.from({ length: 256 }).map((e, t) => BigInt(t)),
  qu = new Float64Array(1),
  b_ = new DataView(qu.buffer),
  I_ = new Uint8Array(qu.buffer);
var C_ = new TextEncoder();
var Or = class {
    constructor(t, n) {
      ((this.type = t), (this.decode = n));
    }
    Encode(t) {
      let n = this.type,
        r = jo(n) ? (a) => this.decode(n["~codec"].decode(a)) : this.decode,
        o = jo(n) ? (a) => n["~codec"].encode(t(a)) : t,
        i = { decode: r, encode: o };
      return l.Update(this.type, { "~codec": i }, {});
    }
  },
  Pr = class {
    constructor(t) {
      this.type = t;
    }
    Decode(t) {
      return new Or(this.type, t);
    }
  };
function Lo(e) {
  return new Pr(e);
}
function Ku(e, t) {
  return Lo(e)
    .Decode(t)
    .Encode(() => {
      throw Error("Encode not implemented");
    });
}
function Bu(e, t) {
  return Lo(e)
    .Decode(() => {
      throw Error("Decode not implemented");
    })
    .Encode(t);
}
function jo(e) {
  return (
    Se(e) &&
    u.HasPropertyKey(e, "~codec") &&
    u.IsObject(e["~codec"]) &&
    u.HasPropertyKey(e["~codec"], "encode") &&
    u.HasPropertyKey(e["~codec"], "decode")
  );
}
function Ju(e) {
  return Gn(e);
}
function Sn(e) {
  return Se(e) && u.HasPropertyKey(e, "~immutable");
}
function Pt(e, t = {}) {
  return A("AddReadonly", [e], t);
}
function kn(e, t = {}) {
  return kr(e, t);
}
function Gu(e) {
  return kn(e);
}
function _n(e) {
  return Se(e) && u.HasPropertyKey(e, "~readonly");
}
function Uy(e, t) {
  let n = us(e) ? [...e["~refine"], t] : [t];
  return l.Update(e, { "~refine": n }, {});
}
function zu(...e) {
  let [t, n, r] = Ot.Match(e, {
    3: (o, i, a) => [o, i, a],
    2: (o, i) => [o, i, () => "Refine Error"],
  });
  return Uy(t, { check: n, error: r });
}
function Ky(e) {
  return (
    u.IsObjectNotArray(e) &&
    u.HasPropertyKey(e, "check") &&
    u.HasPropertyKey(e, "error") &&
    u.IsFunction(e.check) &&
    u.IsFunction(e.error)
  );
}
function us(e) {
  return (
    Se(e) &&
    u.HasPropertyKey(e, "~refine") &&
    u.IsArray(e["~refine"]) &&
    u.Every(e["~refine"], 0, (t) => Ky(t))
  );
}
var Hu = "-?(?:0|[1-9][0-9]*)n";
function Ar(e) {
  return l.Create({ "~kind": "BigInt" }, { type: "bigint" }, e);
}
function At(e) {
  return R(e, "BigInt");
}
function No(e) {
  return l.Create({ "~kind": "Boolean" }, { type: "boolean" }, e);
}
function pt(e) {
  return R(e, "Boolean");
}
function Mr(e) {
  return l.Create({ "~kind": "Identifier" }, { name: e });
}
function Wu(e) {
  return R(e, "Identifier");
}
var Do = "-?(?:0|[1-9][0-9]*)";
function Rn(e) {
  return l.Create({ "~kind": "Integer" }, { type: "integer" }, e);
}
function He(e) {
  return R(e, "Integer");
}
var cs = class extends Error {
  constructor(t) {
    (super("Invalid Literal value"),
      Object.defineProperty(this, "cause", {
        value: { value: t },
        writable: !1,
        configurable: !1,
        enumerable: !1,
      }));
  }
};
function By(e) {
  return u.IsBigInt(e)
    ? "bigint"
    : u.IsBoolean(e)
      ? "boolean"
      : u.IsNumber(e)
        ? "number"
        : u.IsString(e)
          ? "string"
          : (() => {
              throw new cs(e);
            })();
}
function X(e, t) {
  return l.Create({ "~kind": "Literal" }, { type: By(e), const: e }, t);
}
function Fo(e) {
  return u.IsBigInt(e) || u.IsBoolean(e) || u.IsNumber(e) || u.IsString(e);
}
function Vu(e) {
  return ne(e) && u.IsNumber(e.const);
}
function Xu(e) {
  return ne(e) && u.IsString(e.const);
}
function ne(e) {
  return R(e, "Literal");
}
function zn(e) {
  return l.Create({ "~kind": "Null" }, { type: "null" }, e);
}
function Hn(e) {
  return R(e, "Null");
}
var qo = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
function ot(e) {
  return l.Create({ "~kind": "Number" }, { type: "number" }, e);
}
function $e(e) {
  return R(e, "Number");
}
function Wn(e) {
  return l.Create({ "~kind": "Symbol" }, { type: "symbol" }, e);
}
function rn(e) {
  return R(e, "Symbol");
}
function On(...e) {
  let [t, n, r] = Ot.Match(e, {
    3: (o, i, a) => [o, i, a],
    2: (o, i) => [o, i, i],
    1: (o) => [o, je(), je()],
  });
  return l.Create({ "~kind": "Parameter" }, { name: t, extends: n, equals: r }, {});
}
function Yu(e) {
  return R(e, "Parameter");
}
var Uo = ".*";
function dt(e) {
  return l.Create({ "~kind": "String" }, { type: "string" }, e);
}
function We(e) {
  return R(e, "String");
}
function B(e, t = {}) {
  return l.Create({ "~kind": "Union" }, { anyOf: e }, t);
}
function P(e) {
  return R(e, "Union");
}
function Qu(e) {
  return l.Discard(e, ["~kind", "anyOf"]);
}
function jr(e) {
  let t = Zu(e);
  return u.IsEqual(t.length, 2) ? t[0] : [];
}
function Jy(e) {
  return !0;
}
function ec(e) {
  return u.ShiftLeft(
    e,
    (t, n) => (Gy(t) ? ec(n) : !1),
    () => !0,
  );
}
function tc(e) {
  return u.IsEqual(e.length, 0) ? !1 : ec(e);
}
function Gy(e) {
  return P(e) ? tc(e.anyOf) : ne(e) ? Jy(e.const) : !1;
}
function Ko(e) {
  return tc(e);
}
function Bo(e) {
  return l.Create({ "~kind": "TemplateLiteral" }, { type: "string", pattern: e }, {});
}
function nc(e, t, n = []) {
  return u.ShiftLeft(
    e,
    (r, o) => nc(o, t, [...n, `${r}${t}`]),
    () => n,
  );
}
function zy(e, t) {
  return u.IsEqual(e.length, 0) ? [`${t}`] : nc(e, t);
}
function rc(e, t, n = []) {
  return u.ShiftLeft(
    t,
    (r, o) => rc(e, o, [...n, ...oc(e, r)]),
    () => n,
  );
}
function oc(e, t) {
  return P(t) ? rc(e, t.anyOf) : ne(t) ? zy(e, t.const) : ke();
}
function ic(e, t) {
  return u.ShiftLeft(
    t,
    (n, r) => ic(oc(e, n), r),
    () => e,
  );
}
function Hy(e) {
  return e.map((t) => X(t));
}
function Wy(e) {
  let t = ic([], e),
    n = Hy(t);
  return B(n);
}
function Vy(e) {
  return u.IsEqual(e.length, 0) ? ke() : u.IsEqual(e.length, 1) && ne(e[0]) ? e[0] : Wy(e);
}
function ms(e) {
  let t = jr(e);
  return u.IsEqual(t.length, 0) ? dt() : Ko(t) ? Vy(t) : Bo(e);
}
function sc(e) {
  let t = ms(e);
  return be(t) ? dt() : t;
}
function Qe(e, t) {
  let n = "object",
    r = { [e]: t };
  return l.Create({ "~kind": "Record" }, { type: n, patternProperties: r });
}
function ac(e) {
  return Qe(yt, e);
}
function uc(e) {
  return N({ true: e, false: e });
}
function Te(e, t = {}) {
  let [n, r, o] = [e, e.length, !1];
  return l.Create(
    { "~kind": "Tuple" },
    { type: "array", additionalItems: o, items: n, minItems: r },
    t,
  );
}
function ue(e) {
  return R(e, "Tuple");
}
function cc(e) {
  return l.Discard(e, ["~kind", "type", "items", "minItems", "additionalItems"]);
}
function Xy(e) {
  return l.Discard(e, ["~readonly"]);
}
function ps(e, t) {
  return l.Update(Xy(e), {}, t);
}
function mc(e, t, n, r) {
  let o = w(e, t, n);
  return ps(o, r);
}
function pc(e, t = {}) {
  return A("RemoveReadonly", [e], t);
}
function dc(e, t = {}) {
  return ps(e, t);
}
function Yy(e) {
  return l.Discard(e, ["~optional"]);
}
function ds(e, t) {
  return l.Update(Yy(e), {}, t);
}
function lc(e, t, n, r) {
  let o = w(e, t, n);
  return ds(o, r);
}
function fc(e, t = {}) {
  return A("RemoveOptional", [e], t);
}
function Jo(e, t = {}) {
  return ds(e, t);
}
function ls(e) {
  return e.reduceRight((n, r, o) => ({ [o]: r, ...n }), {});
}
function gc(e) {
  let t = ls(e.items);
  return N(t);
}
function fs(e) {
  return te(e) || ue(e);
}
function Qy(e, t) {
  return _n(e) ? !!_n(t) : !1;
}
function Zy(e, t) {
  return Be(e) ? !!Be(t) : !1;
}
function eb(e, t) {
  let n = Qy(e, t),
    r = Zy(e, t),
    o = fe([e, t]),
    i = dc(Jo(o));
  return n && r ? kn(Tn(i)) : n && !r ? kn(i) : !n && r ? Tn(i) : i;
}
function tb(e, t, n) {
  return n in e ? (n in t ? eb(e[n], t[n]) : e[n]) : n in t ? t[n] : oe();
}
function nb(e, t) {
  return [...new Set([...u.Keys(e), ...u.Keys(t)])].reduce(
    (o, i) => ({ ...o, [i]: tb(e, t, i) }),
    {},
  );
}
function hc(e) {
  return te(e) ? e.properties : ue(e) ? ls(e.items) : {};
}
function xc(e, t) {
  let n = hc(e),
    r = hc(t),
    o = nb(n, r);
  return N(o);
}
function rb(e, t) {
  let n = Dr(e, t);
  return u.IsEqual(n, Nr) ? e : u.IsEqual(n, Go) || u.IsEqual(n, Lr) ? t : oe();
}
function ob(e, t) {
  let n = fs(e),
    r = fs(t);
  return n && r ? xc(e, t) : n && !r ? e : !n && r ? t : rb(e, t);
}
function yc(e, t) {
  return xt(e) || he(e) ? e : Ee(e) || xt(t) || he(t) ? t : Ee(t) ? e : ob(e, t);
}
function ib(e, t) {
  return P(e) || P(t);
}
function sb(e, t) {
  let n = lt(e),
    r = lt(t);
  return ib(n, r) ? fe([n, r]) : yc(n, r);
}
function bc(e, t, n = []) {
  return u.ShiftLeft(
    t,
    (r, o) => bc(e, o, [...n, sb(r, e)]),
    () => (u.IsEqual(n.length, 0) ? [e] : n),
  );
}
function Ic(e, t, n = []) {
  return u.ShiftLeft(
    e,
    (r, o) => Ic(o, t, [...n, ...Fr([r], t)]),
    () => n,
  );
}
function Fr(e, t = []) {
  return u.ShiftLeft(
    e,
    (n, r) => (P(n) ? Fr(r, Ic(n.anyOf, t)) : Fr(r, bc(n, t))),
    () => t,
  );
}
function ab(e, t) {
  let n = qe({}, e, t);
  return D.IsExtendsTrueLike(n) ? [] : [e];
}
function Cc(e, t, n = []) {
  return u.ShiftLeft(
    e,
    (r, o) => Cc(o, t, [...n, ...ab(r, t)]),
    () => n,
  );
}
function zo(e, t) {
  let n = lt(e),
    r = P(n) ? n.anyOf : [n],
    o = Cc(r, t);
  return Ze(o);
}
function bt(e, t, n) {
  let r = fe([e, t]),
    o = zo(n, e);
  return Ze([r, o]);
}
function Ve(e, t = []) {
  return u.ShiftLeft(
    e,
    (n, r) => Ve(r, [...t, X(n)]),
    () => Ze(t),
  );
}
function fe(e) {
  let t = Fr(e),
    n = gs(t);
  return Ze(n);
}
function Je(e) {
  let t = sc(e);
  return lt(t);
}
function Ze(e) {
  let t = gs(e);
  return on(t);
}
function lt(e) {
  return ye(e)
    ? bt(e.if, e.then, e.else)
    : Fe(e)
      ? Ve(e.enum)
      : V(e)
        ? fe(e.allOf)
        : be(e)
          ? Je(e.pattern)
          : P(e)
            ? Ze(e.anyOf)
            : e;
}
function on(e) {
  return u.IsEqual(e.length, 1) ? e[0] : u.IsEqual(e.length, 0) ? oe() : B(e);
}
function Ec(e, t) {
  let n = Ve(e);
  return sn(n, t);
}
function wc(e, t) {
  return Qe(an, t);
}
function $c(e, t) {
  let n = fe(e);
  return sn(n, t);
}
function Tc(e, t) {
  return u.IsString(e) || u.IsNumber(e)
    ? N({ [e]: t })
    : u.IsEqual(e, !1)
      ? N({ false: t })
      : u.IsEqual(e, !0)
        ? N({ true: t })
        : N({});
}
function vc(e, t) {
  return Qe(Vn, t);
}
function Sc(e, t) {
  return u.HasPropertyKey(e, "pattern") && (u.IsString(e.pattern) || e.pattern instanceof RegExp)
    ? Qe(e.pattern.toString(), t)
    : Qe(yt, t);
}
function kc(e, t) {
  let n = jr(e);
  return Ko(n) ? sn(Je(e), t) : Qe(e, t);
}
function ub(e) {
  return P(e) ? Xn(e.anyOf) : [e];
}
function Xn(e, t = []) {
  return u.ShiftLeft(
    e,
    (n, r) => Xn(r, [...t, ...ub(n)]),
    () => t,
  );
}
function cb(e) {
  return e.some((t) => We(t) || $e(t) || He(t));
}
function mb(e, t) {
  return u.IsEqual(cb(e), !0) ? Qe(yt, t) : void 0;
}
function pb(e, t) {
  return e.reduce(
    (n, r) => (ne(r) && (u.IsString(r.const) || u.IsNumber(r.const)) ? { ...n, [r.const]: t } : n),
    {},
  );
}
function db(e, t) {
  let n = pb(e, t);
  return N(n);
}
function _c(e, t) {
  let n = Xn(e),
    r = mb(n, t);
  return Se(r) ? r : db(n, t);
}
function sn(e, t) {
  return he(e)
    ? ac(t)
    : pt(e)
      ? uc(t)
      : Fe(e)
        ? Ec(e.enum, t)
        : He(e)
          ? wc(e, t)
          : V(e)
            ? $c(e.allOf, t)
            : ne(e)
              ? Tc(e.const, t)
              : $e(e)
                ? vc(e, t)
                : P(e)
                  ? _c(e.anyOf, t)
                  : We(e)
                    ? Sc(e, t)
                    : be(e)
                      ? kc(e.pattern, t)
                      : N({});
}
function hs(e, t, n) {
  return U([e]) ? l.Update(sn(e, t), {}, n) : Ho(e, t, n);
}
function Rc(e, t, n, r, o) {
  let i = w(e, t, n),
    a = w(e, t, r);
  return hs(i, a, o);
}
var an = `^${Do}$`,
  Vn = `^${qo}$`,
  yt = `^${Uo}$`;
function Ho(e, t, n = {}) {
  return A("Record", [e, t], n);
}
function Wo(e, t, n = {}) {
  return hs(e, t, n);
}
function Oc(e, t) {
  return Qe(e, t);
}
function Vo(e) {
  return u.IsEqual(e, yt) ? dt() : u.IsEqual(e, an) ? Rn() : u.IsEqual(e, Vn) ? ot() : ms(e);
}
function ft(e) {
  return u.Keys(e.patternProperties)[0];
}
function Yn(e) {
  let t = ft(e);
  return Vo(t);
}
function Xe(e) {
  return e.patternProperties[ft(e)];
}
function Ue(e) {
  return R(e, "Record");
}
function Pn(e) {
  return l.Create({ "~kind": "Rest" }, { type: "rest", items: e }, {});
}
function un(e) {
  return R(e, "Rest");
}
function Xo(e) {
  return l.Create({ "~kind": "This" }, { $ref: "#" }, e);
}
function Yo(e) {
  return R(e, "This");
}
function Qn(e) {
  return l.Create({ "~kind": "Undefined" }, { type: "undefined" }, e);
}
function Zn(e) {
  return R(e, "Undefined");
}
function Qo(e) {
  return l.Create({ "~kind": "Void" }, { type: "void" }, e);
}
function Mt(e) {
  return R(e, "Void");
}
function fb(e, t) {
  return u.IsEqual(e, "Array")
    ? st(t[0])
    : u.IsEqual(e, "Capitalize")
      ? ei(t[0])
      : u.IsEqual(e, "ConstructorParameters")
        ? ii(t[0])
        : u.IsEqual(e, "Evaluate")
          ? Pp(t[0])
          : u.IsEqual(e, "Exclude")
            ? si(t[0], t[1])
            : u.IsEqual(e, "Extract")
              ? ai(t[0], t[1])
              : u.IsEqual(e, "Index")
                ? Br(t[0], t[1])
                : u.IsEqual(e, "InstanceType")
                  ? ui(t[0])
                  : u.IsEqual(e, "Lowercase")
                    ? ti(t[0])
                    : u.IsEqual(e, "NonNullable")
                      ? ci(t[0])
                      : u.IsEqual(e, "Omit")
                        ? mi(t[0], t[1])
                        : u.IsEqual(e, "Parameters")
                          ? pi(t[0])
                          : u.IsEqual(e, "Partial")
                            ? di(t[0])
                            : u.IsEqual(e, "Pick")
                              ? li(t[0], t[1])
                              : u.IsEqual(e, "Readonly")
                                ? fi(t[0])
                                : u.IsEqual(e, "KeyOf")
                                  ? Jr(t[0])
                                  : u.IsEqual(e, "Record")
                                    ? Ho(t[0], t[1])
                                    : u.IsEqual(e, "Required")
                                      ? gi(t[0])
                                      : u.IsEqual(e, "ReturnType")
                                        ? hi(t[0])
                                        : u.IsEqual(e, "Uncapitalize")
                                          ? ni(t[0])
                                          : u.IsEqual(e, "Uppercase")
                                            ? ri(t[0])
                                            : Kr(zt(e), t);
}
function An() {
  throw Error("Unreachable");
}
function Lc(e, t = []) {
  return u.ShiftLeft(
    e,
    (n, r) => Lc(r, [...t, n[1]]),
    () => t,
  );
}
function Ht(e) {
  return u.IsEqual(e.length, 3) ? [e[0], ...Lc(e[1])] : [];
}
function Nc(e) {
  return On(e[0], e[2], e[4]);
}
function Dc(e) {
  return On(e[0], e[2], e[2]);
}
function Fc(e) {
  return On(e[0], je(), e[2]);
}
function qc(e) {
  return On(e, je(), je());
}
function Uc(e) {
  return Ht(e);
}
function Kc(e) {
  return e[1];
}
function Bc(e) {
  return Ht(e);
}
function Jc(e) {
  return e[1];
}
function Gc(e) {
  return fb(e[0], e[1]);
}
function zc(e) {
  return null;
}
function Hc(e) {
  return dt();
}
function Wc(e) {
  return ot();
}
function Vc(e) {
  return No();
}
function Xc(e) {
  return Qn();
}
function Yc(e) {
  return zn();
}
function Qc(e) {
  return Rn();
}
function Zc(e) {
  return Ar();
}
function em(e) {
  return je();
}
function tm(e) {
  return Jn();
}
function nm(e) {
  return N({});
}
function rm(e) {
  return oe();
}
function om(e) {
  return Wn();
}
function im(e) {
  return Qo();
}
function sm(e) {
  return Xo();
}
function am(e) {
  return X(BigInt(e));
}
function um(e) {
  return X(u.IsEqual(e, "true"));
}
function cm(e) {
  return X(parseFloat(e));
}
function mm(e) {
  return X(e);
}
function pm(e) {
  return e[1];
}
function dm(e) {
  return X(e);
}
function lm(e) {
  return u.IsEqual(e.length, 3) ? [e[0], e[1], ...e[2]] : [e[0]];
}
function fm(e) {
  return e[1];
}
function gm(e) {
  return Zo(e);
}
function hm(e) {
  return u.IsEqual(e.length, 6) ? vn(e[1], e[3], e[5]) : vn(e[1], e[3], je());
}
function xm(e) {
  return e.length > 0;
}
function ym(e) {
  return e.reduce((t, n) => (u.IsEqual(n.length, 3) ? [...t, [n[1]]] : [...t, []]), []);
}
function bm(e) {
  return u.IsEqual(e.length, 6) ? [e[1], e[3], e[5]] : [];
}
function Im(e) {
  return u.IsArray(e) && u.IsEqual(e.length, 3) ? e[1] : e;
}
function Cm(e) {
  return u.IsEqual(e.length, 2) ? e[1] : [];
}
function Pc(e, t) {
  return t.reduce((n, r) => {
    let o = r;
    return u.IsEqual(o.length, 1) ? Br(n, o[0]) : u.IsEqual(o.length, 0) ? st(n) : An();
  }, e);
}
function Ac(e, t) {
  return u.IsEqual(t.length, 3) ? oi(e, t[0], t[1], t[2]) : e;
}
function gb(e, t) {
  return u.IsArray(t) && u.IsEqual(t.length, 0) ? e : xi(e, t);
}
function Em(e) {
  let [t, n, r, o, i] = e;
  return gb(Ac(t ? Jr(Pc(n, r)) : Pc(n, r), o), i);
}
function xs(e, t) {
  return u.IsEqual(t.length, 3)
    ? (() => {
        let [n, r, o] = t,
          i = xs(r, o);
        if (u.IsEqual(n, "&")) return V(i) ? Ye([e, ...i.allOf]) : Ye([e, i]);
        if (u.IsEqual(n, "|")) return P(i) ? B([e, ...i.anyOf]) : B([e, i]);
        An();
      })()
    : e;
}
function wm(e) {
  let [t, n] = e;
  return xs(t, n);
}
function $m(e) {
  let [t, n] = e;
  return xs(t, n);
}
function Tm(e) {
  return Op(e[1]);
}
function vm(e) {
  return e[1];
}
function Sm(e) {
  return nn(e[0], e[2]);
}
function km(e) {
  return u.IsEqual(e.length, 4) ? Rr(e[1], e[3]) : u.IsEqual(e.length, 2) ? Rr(e[1], je()) : An();
}
function _m(e) {
  return `${e}`;
}
function Rm(e) {
  return He(e[3]) ? an : $e(e[3]) ? Vn : rn(e[3]) ? yt : We(e[3]) ? yt : An();
}
function Om(e) {
  return e.length > 0;
}
function Pm(e) {
  return e.length > 0;
}
function Am(e) {
  let [t, n, r, o, i] = e;
  return { [n]: t && r ? Pt(_t(i)) : t && !r ? Pt(i) : !t && r ? _t(i) : i };
}
function Mm(e) {
  return Ht(e);
}
function jm(e) {
  return e.reduce(
    (t, n) =>
      u.HasPropertyKey(n, an) || u.HasPropertyKey(n, Vn) || u.HasPropertyKey(n, yt)
        ? [t[0], l.Assign(t[1], n)]
        : [l.Assign(t[0], n), t[1]],
    [{}, {}],
  );
}
function Lm(e) {
  return jm(e[1]);
}
function Nm(e) {
  let [t, n] = e,
    r = u.IsEqual(u.Keys(n).length, 0) ? {} : { patternProperties: n };
  return N(t, r);
}
function Dm(e) {
  return u.IsEqual(e.length, 5)
    ? Pt(_t(e[4]))
    : u.IsEqual(e.length, 3)
      ? e[2]
      : u.IsEqual(e.length, 4)
        ? u.IsEqual(e[2], "readonly")
          ? Pt(e[3])
          : _t(e[3])
        : An();
}
function Fm(e) {
  if (!u.IsArray(e) || !u.IsEqual(e.length, 3)) return e;
  let [t, n, r] = e;
  return t && r ? Pt(_t(n)) : t && !r ? Pt(n) : !t && r ? _t(n) : n;
}
function qm(e) {
  return u.IsEqual(e.length, 2) ? Pn(e[1]) : u.IsEqual(e.length, 1) ? e[0] : An();
}
function Um(e) {
  return Ht(e);
}
function Km(e) {
  return Te(e[1]);
}
function Bm(e) {
  return Pt(_t(e[4]));
}
function Jm(e) {
  return Pt(e[3]);
}
function Gm(e) {
  return _t(e[3]);
}
function zm(e) {
  return e[2];
}
function Hm(e) {
  return u.IsEqual(e.length, 2) ? Pn(e[1]) : u.IsEqual(e.length, 1) ? e[0] : An();
}
function Wm(e) {
  return Ht(e);
}
function Vm(e) {
  return kt(e[1], e[4]);
}
function Xm(e) {
  return St(e[2], e[5]);
}
function Mc(e, t) {
  return u.IsEqual(e, "remove") ? pc(t) : u.IsEqual(e, "add") ? Pt(t) : t;
}
function Ym(e) {
  return u.IsEqual(e.length, 2) && u.IsEqual(e[0], "-")
    ? "remove"
    : (u.IsEqual(e.length, 2) && u.IsEqual(e[0], "+")) || u.IsEqual(e.length, 1)
      ? "add"
      : "none";
}
function jc(e, t) {
  return u.IsEqual(e, "remove") ? fc(t) : u.IsEqual(e, "add") ? _t(t) : t;
}
function Qm(e) {
  return u.IsEqual(e.length, 2) && u.IsEqual(e[0], "-")
    ? "remove"
    : (u.IsEqual(e.length, 2) && u.IsEqual(e[0], "+")) || u.IsEqual(e.length, 1)
      ? "add"
      : "none";
}
function Zm(e) {
  return u.IsEqual(e.length, 2) ? [e[1]] : [];
}
function ep(e) {
  return u.IsArray(e[6]) && u.IsEqual(e[6].length, 1)
    ? qr(Mr(e[3]), e[5], e[6][0], Mc(e[1], jc(e[8], e[10])))
    : qr(Mr(e[3]), e[5], zt(e[3]), Mc(e[1], jc(e[8], e[10])));
}
function tp(e) {
  return zt(e);
}
function np(e) {
  return BigInt(e);
}
function rp(e) {
  return parseFloat(e);
}
function op(e) {
  return u.IsEqual(e, "true");
}
function ip(e) {
  return null;
}
function sp(e) {
  return { [e[0]]: e[2] };
}
function ap(e) {
  return Ht(e);
}
function hb(e) {
  return e.reduce((t, n) => l.Assign(t, n), {});
}
function up(e) {
  return hb(e[1]);
}
function cp(e) {
  return Ht(e);
}
function mp(e) {
  return e[1];
}
function pp(e) {
  return Ar();
}
function dp(e) {
  return dt();
}
function lp(e) {
  return ot();
}
function fp(e) {
  return Rn();
}
function gp(e) {
  return oe();
}
function hp(e) {
  return X(e);
}
function xp(e) {
  return B(e[1]);
}
function yp(e) {
  return e.length === 3 ? [...e[0], ...e[2]] : e.length === 1 ? [...e[0]] : [];
}
function bp(e) {
  return [e[0], ...e[1]];
}
function Ip(e) {
  return e[1];
}
function Cp(e) {
  return Ht(e);
}
function Ep(e) {
  return u.IsEqual(e.length, 2) ? e[1] : [];
}
function wp(e) {
  let t = e[2],
    n = e[3],
    [r, o] = e[4],
    i = u.IsEqual(u.Keys(o).length, 0) ? {} : { patternProperties: o };
  return { [e[1]]: nn(t, Ur(n, r, i)) };
}
function $p(e) {
  let t = e[2],
    [n, r] = e[3],
    o = u.IsEqual(u.Keys(r).length, 0) ? {} : { patternProperties: r };
  return { [e[1]]: Ur(t, n, o) };
}
function Tp(e) {
  return { [e[1]]: nn(e[2], e[4]) };
}
function vp(e) {
  return { [e[1]]: e[3] };
}
function Sp(e) {
  return null;
}
function kp(e) {
  return Ht(e);
}
function _p(e) {
  return e[1];
}
function Rp(e) {
  let [t, n] = [e[0], e[1]];
  return Ap(l.Assign(t, jm(n)[0]));
}
function Gr(e) {
  return Q(e.length, 2);
}
function z(e, t, n) {
  return Gr(e) ? t(e[0], e[1]) : n();
}
function bb(e, t) {
  return Q(t.indexOf(e), 0) ? [e, t.slice(e.length)] : [];
}
function xe(e, t) {
  for (let n = 0; n < e.length; n++) {
    let r = bb(e[n], t);
    if (Gr(r)) return r;
  }
  return [];
}
function ys(e, t) {
  return Array.from({ length: t - e + 1 }, (n, r) => String.fromCharCode(e + r));
}
var Mp = [...ys(97, 122), ...ys(65, 90)],
  bs = "0",
  Is = ys(49, 57),
  er = [bs, ...Is],
  jp = " ",
  tr = `
`;
var cn = "_",
  yi = ".",
  Lp = "$",
  bi = "-";
var Np = "//",
  Dp = "/*",
  Cb = "*/";
function Fp(e) {
  let t = e.indexOf(Cb);
  return Q(t, -1) ? "" : e.slice(t + 2);
}
function qp(e) {
  let t = e.indexOf(tr);
  return Q(t, -1) ? "" : e.slice(t);
}
function Eb(e) {
  return e.replace(/^[ \t\r\f\v]+/, "");
}
function Ii(e) {
  let t = Eb(e);
  return t.startsWith(Dp) ? Ii(Fp(t.slice(2))) : t.startsWith(Np) ? Ii(qp(t.slice(2))) : t;
}
function Le(e) {
  let t = e.trimStart();
  return t.startsWith(Dp) ? Le(Fp(t.slice(2))) : t.startsWith(Np) ? Le(qp(t.slice(2))) : t;
}
function Ci(e, t) {
  return z(
    xe([e], t),
    (n, r) => [n, r],
    () => ["", t],
  );
}
function wb(e, t) {
  return e.includes(t);
}
function nr(e, t, n, r = "") {
  return z(
    xe(e, n),
    (o, i) => (wb(t, o) ? nr(e, t, i, r) : nr(e, t, i, `${r}${o}`)),
    () => [r, n],
  );
}
function $b(e) {
  return xe(Is, e);
}
var Tb = [...er, cn];
function vb(e) {
  return nr(Tb, [cn], e);
}
function Sb(e) {
  return z(
    xe([bs], e),
    (t, n) => [t, n],
    () =>
      z(
        $b(e),
        (t, n) =>
          z(
            vb(n),
            (r, o) => [`${t}${r}`, o],
            () => [],
          ),
        () => [],
      ),
  );
}
function Ei(e) {
  return Sb(Le(e));
}
function kb(e) {
  return Ci(bi, e);
}
function _b(e) {
  return z(
    kb(e),
    (t, n) =>
      z(
        Ei(n),
        (r, o) => [`${t}${r}`, o],
        () => [],
      ),
    () => [],
  );
}
function Up(e) {
  return _b(Le(e));
}
function Rb(e) {
  return z(
    Up(e),
    (t, n) =>
      z(
        xe(["n"], n),
        (r, o) => [`${t}`, o],
        () => [],
      ),
    () => [],
  );
}
function Cs(e) {
  return Rb(e);
}
function Es(e, t) {
  return xe([e], t);
}
function f(e, t) {
  return Q(e, "")
    ? ["", t]
    : e.startsWith(tr)
      ? Es(e, Ii(t))
      : e.startsWith(jp)
        ? Es(e, t)
        : Es(e, Le(t));
}
var Kp = [...Mp, cn, Lp];
function Ob(e) {
  return xe(Kp, e);
}
var Pb = [...Kp, ...er];
function Bp(e, t = "") {
  return z(
    xe(Pb, e),
    (n, r) => Bp(r, `${t}${n}`),
    () => [t, e],
  );
}
function Ab(e) {
  return z(
    Ob(e),
    (t, n) =>
      z(
        Bp(n),
        (r, o) => [`${t}${r}`, o],
        () => [],
      ),
    () => [],
  );
}
function Ie(e) {
  return Ab(Le(e));
}
var Mb = [...er, cn];
function jb(e) {
  return Gr(xe([yi], e));
}
function Jp(e) {
  return z(
    nr(Mb, [cn], e),
    (t, n) => (Q(t, "") ? [] : [t, n]),
    () => [],
  );
}
function Lb(e) {
  return z(
    xe([yi], e),
    (t, n) =>
      z(
        Jp(n),
        (r, o) => [`0${t}${r}`, o],
        () => [],
      ),
    () => [],
  );
}
function Nb(e) {
  return z(
    Ei(e),
    (t, n) =>
      z(
        xe([yi], n),
        (r, o) =>
          z(
            Jp(o),
            (i, a) => [`${t}${r}${i}`, a],
            () => [`${t}`, o],
          ),
        () => [`${t}`, n],
      ),
    () => [],
  );
}
function Db(e) {
  return jb(e) ? Lb(e) : Nb(e);
}
function Gp(e) {
  return Db(Le(e));
}
function Fb(e) {
  return Ci(bi, e);
}
function qb(e) {
  return z(
    Fb(e),
    (t, n) =>
      z(
        Gp(n),
        (r, o) => [`${t}${r}`, o],
        () => [],
      ),
    () => [],
  );
}
function wi(e) {
  return qb(Le(e));
}
function Ub(e) {
  return Q(e, "") ? [] : [e.slice(0, 1), e.slice(1)];
}
function zp(e, t) {
  return Ro(
    e,
    (n, r) => (t.startsWith(n) ? !0 : zp(r, t)),
    () => !1,
  );
}
function mn(e, t, n = "") {
  return z(
    Ub(t),
    (r, o) => (zp(e, t) ? [n, t] : mn(e, o, `${n}${r}`)),
    () => [],
  );
}
function Kb(e, t, n) {
  return z(
    xe([e], n),
    (r, o) =>
      z(
        mn([t], o),
        (i, a) =>
          z(
            xe([t], a),
            (c, m) => [`${i}`, m],
            () => [],
          ),
        () => [],
      ),
    () => [],
  );
}
function Bb(e, t, n) {
  return z(
    xe([e], n),
    (r, o) =>
      z(
        mn([tr, t], o),
        (i, a) =>
          z(
            xe([t], a),
            (c, m) => [`${i}`, m],
            () => [],
          ),
        () => [],
      ),
    () => [],
  );
}
function Hp(e, t, n, r) {
  return n ? Kb(e, t, Le(r)) : Bb(e, t, Le(r));
}
function Jb(e, t) {
  return xe(e, t);
}
function Gb(e, t) {
  return Hp(e, e, !1, t);
}
function zb(e, t) {
  return z(
    Jb(e, t),
    (n, r) => Gb(n, `${n}${r}`),
    () => [],
  );
}
function $i(e, t) {
  return zb(e, Le(t));
}
function Wp(e, t) {
  return z(
    mn(e, t),
    (n, r) => (Q(n, "") ? [] : [n, r]),
    () => [],
  );
}
var s = (e, t, n = () => []) => (e.length === 2 ? t(e) : n()),
  Wb = (e) =>
    s(
      s(Ie(e), ([t, n]) =>
        s(f("extends", n), ([r, o]) =>
          s(Z(o), ([i, a]) => s(f("=", a), ([c, m]) => s(Z(m), ([p, d]) => [[t, r, i, c, p], d]))),
        ),
      ),
      ([t, n]) => [Nc(t), n],
    ),
  Vb = (e) =>
    s(
      s(Ie(e), ([t, n]) => s(f("extends", n), ([r, o]) => s(Z(o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Dc(t), n],
    ),
  Xb = (e) =>
    s(
      s(Ie(e), ([t, n]) => s(f("=", n), ([r, o]) => s(Z(o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Fc(t), n],
    ),
  Yb = (e) => s(Ie(e), ([t, n]) => [qc(t), n]),
  Yp = (e) =>
    s(
      s(
        Wb(e),
        ([t, n]) => [t, n],
        () =>
          s(
            Vb(e),
            ([t, n]) => [t, n],
            () =>
              s(
                Xb(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    Yb(e),
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  Qp = (e, t = []) =>
    s(
      s(f(",", e), ([n, r]) => s(Yp(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => Qp(r, [...t, n]),
      () => [t, e],
    ),
  Qb = (e) =>
    s(
      s(
        s(Yp(e), ([t, n]) =>
          s(Qp(n), ([r, o]) =>
            s(
              s(
                f(",", o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Uc(t), n],
    ),
  Ts = (e) =>
    s(
      s(f("<", e), ([t, n]) => s(Qb(n), ([r, o]) => s(f(">", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Kc(t), n],
    ),
  Zp = (e, t = []) =>
    s(
      s(f(",", e), ([n, r]) => s(Z(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => Zp(r, [...t, n]),
      () => [t, e],
    ),
  Zb = (e) =>
    s(
      s(
        s(Z(e), ([t, n]) =>
          s(Zp(n), ([r, o]) =>
            s(
              s(
                f(",", o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Bc(t), n],
    ),
  eI = (e) =>
    s(
      s(f("<", e), ([t, n]) => s(Zb(n), ([r, o]) => s(f(">", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Jc(t), n],
    ),
  tI = (e) =>
    s(
      s(Ie(e), ([t, n]) => s(eI(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [Gc(t), n],
    ),
  ed = (e) =>
    s(
      s(
        s(f(";", e), ([t, n]) => [[t], n]),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [zc(t), n],
    ),
  td = (e) => s(f("string", e), ([t, n]) => [Hc(t), n]),
  nd = (e) => s(f("number", e), ([t, n]) => [Wc(t), n]),
  nI = (e) => s(f("boolean", e), ([t, n]) => [Vc(t), n]),
  rI = (e) => s(f("undefined", e), ([t, n]) => [Xc(t), n]),
  oI = (e) => s(f("null", e), ([t, n]) => [Yc(t), n]),
  rd = (e) => s(f("integer", e), ([t, n]) => [Qc(t), n]),
  iI = (e) => s(f("bigint", e), ([t, n]) => [Zc(t), n]),
  sI = (e) => s(f("unknown", e), ([t, n]) => [em(t), n]),
  aI = (e) => s(f("any", e), ([t, n]) => [tm(t), n]),
  uI = (e) => s(f("object", e), ([t, n]) => [nm(t), n]),
  cI = (e) => s(f("never", e), ([t, n]) => [rm(t), n]),
  od = (e) => s(f("symbol", e), ([t, n]) => [om(t), n]),
  mI = (e) => s(f("void", e), ([t, n]) => [im(t), n]),
  pI = (e) => s(f("this", e), ([t, n]) => [sm(t), n]),
  dI = (e) =>
    s(
      s(f("${", e), ([t, n]) => s(Z(n), ([r, o]) => s(f("}", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [pm(t), n],
    ),
  ws = (e) => s(mn(["${", "`"], e), ([t, n]) => [dm(t), n]),
  id = (e) =>
    s(
      s(
        s(ws(e), ([t, n]) => s(dI(n), ([r, o]) => s(id(o), ([i, a]) => [[t, r, i], a]))),
        ([t, n]) => [t, n],
        () =>
          s(
            s(ws(e), ([t, n]) => [[t], n]),
            ([t, n]) => [t, n],
            () =>
              s(
                s(ws(e), ([t, n]) => [[t], n]),
                ([t, n]) => [t, n],
                () => [],
              ),
          ),
      ),
      ([t, n]) => [lm(t), n],
    ),
  vs = (e) =>
    s(
      s(f("`", e), ([t, n]) => s(id(n), ([r, o]) => s(f("`", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [fm(t), n],
    ),
  lI = (e) => s(vs(e), ([t, n]) => [gm(t), n]),
  fI = (e) =>
    s(
      s(
        s(f("if", e), ([t, n]) =>
          s(Z(n), ([r, o]) =>
            s(f("then", o), ([i, a]) =>
              s(Z(a), ([c, m]) =>
                s(f("else", m), ([p, d]) => s(Z(d), ([g, x]) => [[t, r, i, c, p, g], x])),
              ),
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            s(f("if", e), ([t, n]) =>
              s(Z(n), ([r, o]) =>
                s(f("then", o), ([i, a]) => s(Z(a), ([c, m]) => [[t, r, i, c], m])),
              ),
            ),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [hm(t), n],
    ),
  gI = (e) => s(Cs(e), ([t, n]) => [am(t), n]),
  hI = (e) =>
    s(
      s(
        f("true", e),
        ([t, n]) => [t, n],
        () =>
          s(
            f("false", e),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [um(t), n],
    ),
  xI = (e) => s(wi(e), ([t, n]) => [cm(t), n]),
  yI = (e) => s($i(["'", '"'], e), ([t, n]) => [mm(t), n]),
  bI = (e) =>
    s(
      s(
        s(f("keyof", e), ([t, n]) => [[t], n]),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [xm(t), n],
    ),
  sd = (e, t = []) =>
    s(
      s(
        s(f("[", e), ([n, r]) => s(Z(r), ([o, i]) => s(f("]", i), ([a, c]) => [[n, o, a], c]))),
        ([n, r]) => [n, r],
        () =>
          s(
            s(f("[", e), ([n, r]) => s(f("]", r), ([o, i]) => [[n, o], i])),
            ([n, r]) => [n, r],
            () => [],
          ),
      ),
      ([n, r]) => sd(r, [...t, n]),
      () => [t, e],
    ),
  II = (e) => s(sd(e), ([t, n]) => [ym(t), n]),
  CI = (e) =>
    s(
      s(
        s(f("extends", e), ([t, n]) =>
          s(Z(n), ([r, o]) =>
            s(f("?", o), ([i, a]) =>
              s(Z(a), ([c, m]) =>
                s(f(":", m), ([p, d]) => s(Z(d), ([g, x]) => [[t, r, i, c, p, g], x])),
              ),
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [bm(t), n],
    ),
  EI = (e) =>
    s(
      s(
        s(f("(", e), ([t, n]) => s(Z(n), ([r, o]) => s(f(")", o), ([i, a]) => [[t, r, i], a]))),
        ([t, n]) => [t, n],
        () =>
          s(
            td(e),
            ([t, n]) => [t, n],
            () =>
              s(
                nd(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    nI(e),
                    ([t, n]) => [t, n],
                    () =>
                      s(
                        rI(e),
                        ([t, n]) => [t, n],
                        () =>
                          s(
                            oI(e),
                            ([t, n]) => [t, n],
                            () =>
                              s(
                                rd(e),
                                ([t, n]) => [t, n],
                                () =>
                                  s(
                                    iI(e),
                                    ([t, n]) => [t, n],
                                    () =>
                                      s(
                                        sI(e),
                                        ([t, n]) => [t, n],
                                        () =>
                                          s(
                                            aI(e),
                                            ([t, n]) => [t, n],
                                            () =>
                                              s(
                                                uI(e),
                                                ([t, n]) => [t, n],
                                                () =>
                                                  s(
                                                    cI(e),
                                                    ([t, n]) => [t, n],
                                                    () =>
                                                      s(
                                                        od(e),
                                                        ([t, n]) => [t, n],
                                                        () =>
                                                          s(
                                                            mI(e),
                                                            ([t, n]) => [t, n],
                                                            () =>
                                                              s(
                                                                pI(e),
                                                                ([t, n]) => [t, n],
                                                                () =>
                                                                  s(
                                                                    gI(e),
                                                                    ([t, n]) => [t, n],
                                                                    () =>
                                                                      s(
                                                                        hI(e),
                                                                        ([t, n]) => [t, n],
                                                                        () =>
                                                                          s(
                                                                            xI(e),
                                                                            ([t, n]) => [t, n],
                                                                            () =>
                                                                              s(
                                                                                yI(e),
                                                                                ([t, n]) => [t, n],
                                                                                () =>
                                                                                  s(
                                                                                    lI(e),
                                                                                    ([t, n]) => [
                                                                                      t,
                                                                                      n,
                                                                                    ],
                                                                                    () =>
                                                                                      s(
                                                                                        fI(e),
                                                                                        ([
                                                                                          t,
                                                                                          n,
                                                                                        ]) => [
                                                                                          t,
                                                                                          n,
                                                                                        ],
                                                                                        () =>
                                                                                          s(
                                                                                            AI(e),
                                                                                            ([
                                                                                              t,
                                                                                              n,
                                                                                            ]) => [
                                                                                              t,
                                                                                              n,
                                                                                            ],
                                                                                            () =>
                                                                                              s(
                                                                                                LI(
                                                                                                  e,
                                                                                                ),
                                                                                                ([
                                                                                                  t,
                                                                                                  n,
                                                                                                ]) => [
                                                                                                  t,
                                                                                                  n,
                                                                                                ],
                                                                                                () =>
                                                                                                  s(
                                                                                                    KI(
                                                                                                      e,
                                                                                                    ),
                                                                                                    ([
                                                                                                      t,
                                                                                                      n,
                                                                                                    ]) => [
                                                                                                      t,
                                                                                                      n,
                                                                                                    ],
                                                                                                    () =>
                                                                                                      s(
                                                                                                        UI(
                                                                                                          e,
                                                                                                        ),
                                                                                                        ([
                                                                                                          t,
                                                                                                          n,
                                                                                                        ]) => [
                                                                                                          t,
                                                                                                          n,
                                                                                                        ],
                                                                                                        () =>
                                                                                                          s(
                                                                                                            zI(
                                                                                                              e,
                                                                                                            ),
                                                                                                            ([
                                                                                                              t,
                                                                                                              n,
                                                                                                            ]) => [
                                                                                                              t,
                                                                                                              n,
                                                                                                            ],
                                                                                                            () =>
                                                                                                              s(
                                                                                                                tI(
                                                                                                                  e,
                                                                                                                ),
                                                                                                                ([
                                                                                                                  t,
                                                                                                                  n,
                                                                                                                ]) => [
                                                                                                                  t,
                                                                                                                  n,
                                                                                                                ],
                                                                                                                () =>
                                                                                                                  s(
                                                                                                                    HI(
                                                                                                                      e,
                                                                                                                    ),
                                                                                                                    ([
                                                                                                                      t,
                                                                                                                      n,
                                                                                                                    ]) => [
                                                                                                                      t,
                                                                                                                      n,
                                                                                                                    ],
                                                                                                                    () => [],
                                                                                                                  ),
                                                                                                              ),
                                                                                                          ),
                                                                                                      ),
                                                                                                  ),
                                                                                              ),
                                                                                          ),
                                                                                      ),
                                                                                  ),
                                                                              ),
                                                                          ),
                                                                      ),
                                                                  ),
                                                              ),
                                                          ),
                                                      ),
                                                  ),
                                              ),
                                          ),
                                      ),
                                  ),
                              ),
                          ),
                      ),
                  ),
              ),
          ),
      ),
      ([t, n]) => [Im(t), n],
    ),
  wI = (e) =>
    s(
      s(
        s(f("with", e), ([t, n]) => s(wd(n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Cm(t), n],
    ),
  ad = (e) =>
    s(
      s(bI(e), ([t, n]) =>
        s(EI(n), ([r, o]) =>
          s(II(o), ([i, a]) => s(CI(a), ([c, m]) => s(wI(m), ([p, d]) => [[t, r, i, c, p], d]))),
        ),
      ),
      ([t, n]) => [Em(t), n],
    ),
  ud = (e) =>
    s(
      s(
        s(f("&", e), ([t, n]) => s(ad(n), ([r, o]) => s(ud(o), ([i, a]) => [[t, r, i], a]))),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [t, n],
    ),
  cd = (e) =>
    s(
      s(ad(e), ([t, n]) => s(ud(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [wm(t), n],
    ),
  md = (e) =>
    s(
      s(
        s(f("|", e), ([t, n]) => s(cd(n), ([r, o]) => s(md(o), ([i, a]) => [[t, r, i], a]))),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [t, n],
    ),
  Ti = (e) =>
    s(
      s(cd(e), ([t, n]) => s(md(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [$m(t), n],
    ),
  $I = (e) =>
    s(
      s(f("readonly", e), ([t, n]) => s(Ti(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [Tm(t), n],
    ),
  TI = (e) =>
    s(
      s(f("|", e), ([t, n]) => s(Ti(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [vm(t), n],
    ),
  vI = (e) =>
    s(
      s(Ts(e), ([t, n]) => s(f("=", n), ([r, o]) => s(Z(o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Sm(t), n],
    ),
  SI = (e) =>
    s(
      s(
        s(f("infer", e), ([t, n]) =>
          s(Ie(n), ([r, o]) =>
            s(f("extends", o), ([i, a]) => s(Ti(a), ([c, m]) => [[t, r, i, c], m])),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            s(f("infer", e), ([t, n]) => s(Ie(n), ([r, o]) => [[t, r], o])),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [km(t), n],
    ),
  Z = (e) =>
    s(
      s(
        SI(e),
        ([t, n]) => [t, n],
        () =>
          s(
            TI(e),
            ([t, n]) => [t, n],
            () =>
              s(
                $I(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    Ti(e),
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  kI = (e) => s(wi(e), ([t, n]) => [_m(t), n]),
  _I = (e) => s(Ie(e), ([t, n]) => [t, n]),
  RI = (e) => s($i(["'", '"'], e), ([t, n]) => [t, n]),
  OI = (e) =>
    s(
      s(f("[", e), ([t, n]) =>
        s(Ie(n), ([r, o]) =>
          s(f(":", o), ([i, a]) =>
            s(
              s(
                rd(a),
                ([c, m]) => [c, m],
                () =>
                  s(
                    nd(a),
                    ([c, m]) => [c, m],
                    () =>
                      s(
                        td(a),
                        ([c, m]) => [c, m],
                        () =>
                          s(
                            od(a),
                            ([c, m]) => [c, m],
                            () => [],
                          ),
                      ),
                  ),
              ),
              ([c, m]) => s(f("]", m), ([p, d]) => [[t, r, i, c, p], d]),
            ),
          ),
        ),
      ),
      ([t, n]) => [Rm(t), n],
    ),
  pd = (e) =>
    s(
      s(
        kI(e),
        ([t, n]) => [t, n],
        () =>
          s(
            _I(e),
            ([t, n]) => [t, n],
            () =>
              s(
                RI(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    OI(e),
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  dd = (e) =>
    s(
      s(
        s(f("readonly", e), ([t, n]) => [[t], n]),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Om(t), n],
    ),
  ld = (e) =>
    s(
      s(
        s(f("?", e), ([t, n]) => [[t], n]),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Pm(t), n],
    ),
  fd = (e) =>
    s(
      s(dd(e), ([t, n]) =>
        s(pd(n), ([r, o]) =>
          s(ld(o), ([i, a]) => s(f(":", a), ([c, m]) => s(Z(m), ([p, d]) => [[t, r, i, c, p], d]))),
        ),
      ),
      ([t, n]) => [Am(t), n],
    ),
  vi = (e) =>
    s(
      s(
        s(f(",", e), ([t, n]) =>
          s(
            f(
              `
`,
              n,
            ),
            ([r, o]) => [[t, r], o],
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            s(f(";", e), ([t, n]) =>
              s(
                f(
                  `
`,
                  n,
                ),
                ([r, o]) => [[t, r], o],
              ),
            ),
            ([t, n]) => [t, n],
            () =>
              s(
                s(f(",", e), ([t, n]) => [[t], n]),
                ([t, n]) => [t, n],
                () =>
                  s(
                    s(f(";", e), ([t, n]) => [[t], n]),
                    ([t, n]) => [t, n],
                    () =>
                      s(
                        s(
                          f(
                            `
`,
                            e,
                          ),
                          ([t, n]) => [[t], n],
                        ),
                        ([t, n]) => [t, n],
                        () => [],
                      ),
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  gd = (e, t = []) =>
    s(
      s(vi(e), ([n, r]) => s(fd(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => gd(r, [...t, n]),
      () => [t, e],
    ),
  PI = (e) =>
    s(
      s(
        s(fd(e), ([t, n]) =>
          s(gd(n), ([r, o]) =>
            s(
              s(
                vi(o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Mm(t), n],
    ),
  Ss = (e) =>
    s(
      s(f("{", e), ([t, n]) => s(PI(n), ([r, o]) => s(f("}", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Lm(t), n],
    ),
  AI = (e) => s(Ss(e), ([t, n]) => [Nm(t), n]),
  MI = (e) =>
    s(
      s(
        s(Ie(e), ([t, n]) =>
          s(f("?", n), ([r, o]) =>
            s(f(":", o), ([i, a]) =>
              s(f("readonly", a), ([c, m]) => s(Z(m), ([p, d]) => [[t, r, i, c, p], d])),
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            s(Ie(e), ([t, n]) =>
              s(f(":", n), ([r, o]) =>
                s(f("readonly", o), ([i, a]) => s(Z(a), ([c, m]) => [[t, r, i, c], m])),
              ),
            ),
            ([t, n]) => [t, n],
            () =>
              s(
                s(Ie(e), ([t, n]) =>
                  s(f("?", n), ([r, o]) =>
                    s(f(":", o), ([i, a]) => s(Z(a), ([c, m]) => [[t, r, i, c], m])),
                  ),
                ),
                ([t, n]) => [t, n],
                () =>
                  s(
                    s(Ie(e), ([t, n]) =>
                      s(f(":", n), ([r, o]) => s(Z(o), ([i, a]) => [[t, r, i], a])),
                    ),
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [Dm(t), n],
    ),
  Vp = (e) =>
    s(
      s(
        MI(e),
        ([t, n]) => [t, n],
        () =>
          s(
            s(dd(e), ([t, n]) => s(Z(n), ([r, o]) => s(ld(o), ([i, a]) => [[t, r, i], a]))),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Fm(t), n],
    ),
  hd = (e) =>
    s(
      s(
        s(f("...", e), ([t, n]) => s(Vp(n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            s(Vp(e), ([t, n]) => [[t], n]),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [qm(t), n],
    ),
  xd = (e, t = []) =>
    s(
      s(f(",", e), ([n, r]) => s(hd(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => xd(r, [...t, n]),
      () => [t, e],
    ),
  jI = (e) =>
    s(
      s(
        s(hd(e), ([t, n]) =>
          s(xd(n), ([r, o]) =>
            s(
              s(
                f(",", o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Um(t), n],
    ),
  LI = (e) =>
    s(
      s(f("[", e), ([t, n]) => s(jI(n), ([r, o]) => s(f("]", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Km(t), n],
    ),
  NI = (e) =>
    s(
      s(Ie(e), ([t, n]) =>
        s(f("?", n), ([r, o]) =>
          s(f(":", o), ([i, a]) =>
            s(f("readonly", a), ([c, m]) => s(Z(m), ([p, d]) => [[t, r, i, c, p], d])),
          ),
        ),
      ),
      ([t, n]) => [Bm(t), n],
    ),
  DI = (e) =>
    s(
      s(Ie(e), ([t, n]) =>
        s(f(":", n), ([r, o]) =>
          s(f("readonly", o), ([i, a]) => s(Z(a), ([c, m]) => [[t, r, i, c], m])),
        ),
      ),
      ([t, n]) => [Jm(t), n],
    ),
  FI = (e) =>
    s(
      s(Ie(e), ([t, n]) =>
        s(f("?", n), ([r, o]) => s(f(":", o), ([i, a]) => s(Z(a), ([c, m]) => [[t, r, i, c], m]))),
      ),
      ([t, n]) => [Gm(t), n],
    ),
  qI = (e) =>
    s(
      s(Ie(e), ([t, n]) => s(f(":", n), ([r, o]) => s(Z(o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [zm(t), n],
    ),
  Xp = (e) =>
    s(
      s(
        NI(e),
        ([t, n]) => [t, n],
        () =>
          s(
            DI(e),
            ([t, n]) => [t, n],
            () =>
              s(
                FI(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    qI(e),
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  yd = (e) =>
    s(
      s(
        s(f("...", e), ([t, n]) => s(Xp(n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            s(Xp(e), ([t, n]) => [[t], n]),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Hm(t), n],
    ),
  bd = (e, t = []) =>
    s(
      s(f(",", e), ([n, r]) => s(yd(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => bd(r, [...t, n]),
      () => [t, e],
    ),
  Id = (e) =>
    s(
      s(
        s(yd(e), ([t, n]) =>
          s(bd(n), ([r, o]) =>
            s(
              s(
                f(",", o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Wm(t), n],
    ),
  UI = (e) =>
    s(
      s(f("(", e), ([t, n]) =>
        s(Id(n), ([r, o]) =>
          s(f(")", o), ([i, a]) =>
            s(f("=>", a), ([c, m]) => s(Z(m), ([p, d]) => [[t, r, i, c, p], d])),
          ),
        ),
      ),
      ([t, n]) => [Vm(t), n],
    ),
  KI = (e) =>
    s(
      s(f("new", e), ([t, n]) =>
        s(f("(", n), ([r, o]) =>
          s(Id(o), ([i, a]) =>
            s(f(")", a), ([c, m]) =>
              s(f("=>", m), ([p, d]) => s(Z(d), ([g, x]) => [[t, r, i, c, p, g], x])),
            ),
          ),
        ),
      ),
      ([t, n]) => [Xm(t), n],
    ),
  BI = (e) =>
    s(
      s(
        s(f("+", e), ([t, n]) => s(f("readonly", n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            s(f("-", e), ([t, n]) => s(f("readonly", n), ([r, o]) => [[t, r], o])),
            ([t, n]) => [t, n],
            () =>
              s(
                s(f("readonly", e), ([t, n]) => [[t], n]),
                ([t, n]) => [t, n],
                () =>
                  s(
                    [[], e],
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [Ym(t), n],
    ),
  JI = (e) =>
    s(
      s(
        s(f("+", e), ([t, n]) => s(f("?", n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            s(f("-", e), ([t, n]) => s(f("?", n), ([r, o]) => [[t, r], o])),
            ([t, n]) => [t, n],
            () =>
              s(
                s(f("?", e), ([t, n]) => [[t], n]),
                ([t, n]) => [t, n],
                () =>
                  s(
                    [[], e],
                    ([t, n]) => [t, n],
                    () => [],
                  ),
              ),
          ),
      ),
      ([t, n]) => [Qm(t), n],
    ),
  GI = (e) =>
    s(
      s(
        s(f("as", e), ([t, n]) => s(Z(n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Zm(t), n],
    ),
  zI = (e) =>
    s(
      s(f("{", e), ([t, n]) =>
        s(BI(n), ([r, o]) =>
          s(f("[", o), ([i, a]) =>
            s(Ie(a), ([c, m]) =>
              s(f("in", m), ([p, d]) =>
                s(Z(d), ([g, x]) =>
                  s(GI(x), ([I, T]) =>
                    s(f("]", T), ([$, y]) =>
                      s(JI(y), ([h, E]) =>
                        s(f(":", E), ([v, O]) =>
                          s(Z(O), ([b, G]) =>
                            s(ed(G), ([L, ie]) =>
                              s(f("}", ie), ([K, q]) => [
                                [t, r, i, c, p, g, I, $, h, v, b, L, K],
                                q,
                              ]),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      ([t, n]) => [ep(t), n],
    ),
  HI = (e) => s(Ie(e), ([t, n]) => [tp(t), n]),
  WI = (e) => s(Cs(e), ([t, n]) => [np(t), n]),
  VI = (e) => s(wi(e), ([t, n]) => [rp(t), n]),
  XI = (e) =>
    s(
      s(
        f("true", e),
        ([t, n]) => [t, n],
        () =>
          s(
            f("false", e),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [op(t), n],
    ),
  YI = (e) => s($i(['"', "'"], e), ([t, n]) => [t, n]),
  QI = (e) => s(f("null", e), ([t, n]) => [ip(t), n]),
  ZI = (e) => s(f("undefined", e), ([t, n]) => [void 0, n]),
  Cd = (e) =>
    s(
      s(pd(e), ([t, n]) => s(f(":", n), ([r, o]) => s(ks(o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [sp(t), n],
    ),
  Ed = (e, t = []) =>
    s(
      s(vi(e), ([n, r]) => s(Cd(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => Ed(r, [...t, n]),
      () => [t, e],
    ),
  eC = (e) =>
    s(
      s(
        s(Cd(e), ([t, n]) =>
          s(Ed(n), ([r, o]) =>
            s(
              s(
                vi(o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [ap(t), n],
    ),
  wd = (e) =>
    s(
      s(f("{", e), ([t, n]) => s(eC(n), ([r, o]) => s(f("}", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [up(t), n],
    ),
  $d = (e, t = []) =>
    s(
      s(f(",", e), ([n, r]) => s(ks(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => $d(r, [...t, n]),
      () => [t, e],
    ),
  tC = (e) =>
    s(
      s(
        s(ks(e), ([t, n]) =>
          s($d(n), ([r, o]) =>
            s(
              s(
                f(",", o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [cp(t), n],
    ),
  nC = (e) =>
    s(
      s(f("[", e), ([t, n]) => s(tC(n), ([r, o]) => s(f("]", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [mp(t), n],
    ),
  ks = (e) =>
    s(
      s(
        WI(e),
        ([t, n]) => [t, n],
        () =>
          s(
            VI(e),
            ([t, n]) => [t, n],
            () =>
              s(
                XI(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    YI(e),
                    ([t, n]) => [t, n],
                    () =>
                      s(
                        QI(e),
                        ([t, n]) => [t, n],
                        () =>
                          s(
                            ZI(e),
                            ([t, n]) => [t, n],
                            () =>
                              s(
                                wd(e),
                                ([t, n]) => [t, n],
                                () =>
                                  s(
                                    nC(e),
                                    ([t, n]) => [t, n],
                                    () => [],
                                  ),
                              ),
                          ),
                      ),
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  rC = (e) => s(f("-?(?:0|[1-9][0-9]*)n", e), ([t, n]) => [pp(t), n]),
  oC = (e) => s(f(".*", e), ([t, n]) => [dp(t), n]),
  iC = (e) => s(f("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", e), ([t, n]) => [lp(t), n]),
  sC = (e) => s(f("-?(?:0|[1-9][0-9]*)", e), ([t, n]) => [fp(t), n]),
  aC = (e) => s(f("(?!)", e), ([t, n]) => [gp(t), n]),
  uC = (e) =>
    s(
      Wp(
        [
          "-?(?:0|[1-9][0-9]*)n",
          ".*",
          "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?",
          "-?(?:0|[1-9][0-9]*)",
          "(?!)",
          "(",
          ")",
          "$",
          "|",
        ],
        e,
      ),
      ([t, n]) => [hp(t), n],
    ),
  cC = (e) =>
    s(
      s(
        rC(e),
        ([t, n]) => [t, n],
        () =>
          s(
            oC(e),
            ([t, n]) => [t, n],
            () =>
              s(
                iC(e),
                ([t, n]) => [t, n],
                () =>
                  s(
                    sC(e),
                    ([t, n]) => [t, n],
                    () =>
                      s(
                        aC(e),
                        ([t, n]) => [t, n],
                        () =>
                          s(
                            mC(e),
                            ([t, n]) => [t, n],
                            () =>
                              s(
                                uC(e),
                                ([t, n]) => [t, n],
                                () => [],
                              ),
                          ),
                      ),
                  ),
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  mC = (e) =>
    s(
      s(f("(", e), ([t, n]) => s(_s(n), ([r, o]) => s(f(")", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [xp(t), n],
    ),
  Td = (e) =>
    s(
      s(
        s($s(e), ([t, n]) => s(f("|", n), ([r, o]) => s(Td(o), ([i, a]) => [[t, r, i], a]))),
        ([t, n]) => [t, n],
        () =>
          s(
            s($s(e), ([t, n]) => [[t], n]),
            ([t, n]) => [t, n],
            () =>
              s(
                [[], e],
                ([t, n]) => [t, n],
                () => [],
              ),
          ),
      ),
      ([t, n]) => [yp(t), n],
    ),
  $s = (e) =>
    s(
      s(cC(e), ([t, n]) => s(_s(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [bp(t), n],
    ),
  _s = (e) =>
    s(
      s(
        Td(e),
        ([t, n]) => [t, n],
        () =>
          s(
            $s(e),
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [t, n],
    ),
  Zu = (e) =>
    s(
      s(f("^", e), ([t, n]) => s(_s(n), ([r, o]) => s(f("$", o), ([i, a]) => [[t, r, i], a]))),
      ([t, n]) => [Ip(t), n],
    ),
  vd = (e, t = []) =>
    s(
      s(f(",", e), ([n, r]) => s(Z(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => vd(r, [...t, n]),
      () => [t, e],
    ),
  pC = (e) =>
    s(
      s(
        s(Z(e), ([t, n]) =>
          s(vd(n), ([r, o]) =>
            s(
              s(
                f(",", o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Cp(t), n],
    ),
  Sd = (e) =>
    s(
      s(
        s(f("extends", e), ([t, n]) => s(pC(n), ([r, o]) => [[t, r], o])),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Ep(t), n],
    ),
  dC = (e) =>
    s(
      s(f("interface", e), ([t, n]) =>
        s(Ie(n), ([r, o]) =>
          s(Ts(o), ([i, a]) => s(Sd(a), ([c, m]) => s(Ss(m), ([p, d]) => [[t, r, i, c, p], d]))),
        ),
      ),
      ([t, n]) => [wp(t), n],
    ),
  lC = (e) =>
    s(
      s(f("interface", e), ([t, n]) =>
        s(Ie(n), ([r, o]) => s(Sd(o), ([i, a]) => s(Ss(a), ([c, m]) => [[t, r, i, c], m]))),
      ),
      ([t, n]) => [$p(t), n],
    ),
  fC = (e) =>
    s(
      s(f("type", e), ([t, n]) =>
        s(Ie(n), ([r, o]) =>
          s(Ts(o), ([i, a]) => s(f("=", a), ([c, m]) => s(Z(m), ([p, d]) => [[t, r, i, c, p], d]))),
        ),
      ),
      ([t, n]) => [Tp(t), n],
    ),
  gC = (e) =>
    s(
      s(f("type", e), ([t, n]) =>
        s(Ie(n), ([r, o]) => s(f("=", o), ([i, a]) => s(Z(a), ([c, m]) => [[t, r, i, c], m]))),
      ),
      ([t, n]) => [vp(t), n],
    ),
  hC = (e) =>
    s(
      s(
        s(f("export", e), ([t, n]) => [[t], n]),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [Sp(t), n],
    ),
  kd = (e) =>
    s(
      s(
        s(f(";", e), ([t, n]) =>
          s(
            f(
              `
`,
              n,
            ),
            ([r, o]) => [[t, r], o],
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            s(f(";", e), ([t, n]) => [[t], n]),
            ([t, n]) => [t, n],
            () =>
              s(
                s(
                  f(
                    `
`,
                    e,
                  ),
                  ([t, n]) => [[t], n],
                ),
                ([t, n]) => [t, n],
                () => [],
              ),
          ),
      ),
      ([t, n]) => [t, n],
    ),
  _d = (e, t = []) =>
    s(
      s(kd(e), ([n, r]) => s(Rs(r), ([o, i]) => [[n, o], i])),
      ([n, r]) => _d(r, [...t, n]),
      () => [t, e],
    ),
  xC = (e) =>
    s(
      s(
        s(Rs(e), ([t, n]) =>
          s(_d(n), ([r, o]) =>
            s(
              s(
                kd(o),
                ([i, a]) => [[i], a],
                () => [[], o],
              ),
              ([i, a]) => [[t, r, i], a],
            ),
          ),
        ),
        ([t, n]) => [t, n],
        () =>
          s(
            [[], e],
            ([t, n]) => [t, n],
            () => [],
          ),
      ),
      ([t, n]) => [kp(t), n],
    ),
  Rs = (e) =>
    s(
      s(hC(e), ([t, n]) =>
        s(
          s(
            dC(n),
            ([r, o]) => [r, o],
            () =>
              s(
                lC(n),
                ([r, o]) => [r, o],
                () =>
                  s(
                    fC(n),
                    ([r, o]) => [r, o],
                    () =>
                      s(
                        gC(n),
                        ([r, o]) => [r, o],
                        () => [],
                      ),
                  ),
              ),
          ),
          ([r, o]) => s(ed(o), ([i, a]) => [[t, r, i], a]),
        ),
      ),
      ([t, n]) => [_p(t), n],
    ),
  yC = (e) =>
    s(
      s(Rs(e), ([t, n]) => s(xC(n), ([r, o]) => [[t, r], o])),
      ([t, n]) => [Rp(t), n],
    ),
  Rd = (e) =>
    s(
      s(
        yC(e),
        ([t, n]) => [t, n],
        () =>
          s(
            vI(e),
            ([t, n]) => [t, n],
            () =>
              s(
                Z(e),
                ([t, n]) => [t, n],
                () => [],
              ),
          ),
      ),
      ([t, n]) => [t, n],
    );
function Od(e) {
  let t = vs(`\`${e}\``);
  return u.IsEqual(t.length, 2) ? t[0] : ke();
}
function IC(e) {
  return e.join("|");
}
function CC(e) {
  return e.slice(1, e.length - 1);
}
function EC(e, t, n) {
  return pn(t, `${n}${e}`);
}
function wC(e, t) {
  return pn(e, `${t}${Hu}`);
}
function $C(e, t) {
  return pn(e, `${t}${Do}`);
}
function TC(e, t) {
  return pn(e, `${t}${qo}`);
}
function vC(e, t) {
  return zr(B([X("false"), X("true")]), e, t);
}
function SC(e, t) {
  return pn(e, `${t}${Uo}`);
}
function kC(e, t, n) {
  return pn(t, `${n}${CC(e)}`);
}
function _C(e, t, n) {
  let r = Hr(e, {});
  return zr(r, t, n);
}
function RC(e, t, n) {
  let r = Ve(e);
  return zr(r, t, n);
}
function Pd(e, t, n, r = []) {
  return u.ShiftLeft(
    e,
    (o, i) => Pd(i, t, n, [...r, zr(o, [], "")]),
    () => pn(t, `${n}(${IC(r)})`),
  );
}
function zr(e, t, n) {
  return Fe(e)
    ? RC(e.enum, t, n)
    : He(e)
      ? $C(t, n)
      : ne(e)
        ? EC(e.const, t, n)
        : At(e)
          ? wC(t, n)
          : pt(e)
            ? vC(t, n)
            : $e(e)
              ? TC(t, n)
              : We(e)
                ? SC(t, n)
                : be(e)
                  ? kC(e.pattern, t, n)
                  : Md(e)
                    ? _C(e.parameters[0], t, n)
                    : P(e)
                      ? Pd(e.anyOf, t, n)
                      : ku;
}
function pn(e, t) {
  return u.ShiftLeft(
    e,
    (n, r) => zr(n, r, t),
    () => t,
  );
}
function OC(e) {
  return `^${pn(e, "")}$`;
}
function Ad(e) {
  let t = OC(e);
  return Bo(t);
}
function Hr(e, t) {
  return U(e) ? l.Update(Ad(e), {}, t) : Zo(e, t);
}
function jd(e, t, n, r) {
  let o = at(e, t, n);
  return Hr(o, r);
}
function Zo(e, t = {}) {
  return A("TemplateLiteral", [e], t);
}
function Md(e) {
  return Se(e) && u.HasPropertyKey(e, "action") && u.IsEqual(e.action, "TemplateLiteral");
}
function Ld(e) {
  return Hr(e, {});
}
function PC(e) {
  let t = Od(e);
  return Ld(t);
}
function Nd(e, t = {}) {
  let n = u.IsString(e) ? PC(e) : Ld(e);
  return l.Update(n, {}, t);
}
function be(e) {
  return R(e, "TemplateLiteral");
}
var D = {};
En(D, {
  ExtendsFalse: () => F,
  ExtendsTrue: () => S,
  ExtendsUnion: () => Os,
  IsExtendsFalse: () => AC,
  IsExtendsTrue: () => Fd,
  IsExtendsTrueLike: () => rr,
  IsExtendsUnion: () => Dd,
  Match: () => pe,
});
function Os(e) {
  return l.Create({ "~kind": "ExtendsUnion" }, { inferred: e });
}
function Dd(e) {
  return (
    u.IsObject(e) &&
    u.HasPropertyKey(e, "~kind") &&
    u.HasPropertyKey(e, "inferred") &&
    u.IsEqual(e["~kind"], "ExtendsUnion") &&
    u.IsObject(e.inferred)
  );
}
function S(e) {
  return l.Create({ "~kind": "ExtendsTrue" }, { inferred: e });
}
function Fd(e) {
  return (
    u.IsObject(e) &&
    u.HasPropertyKey(e, "~kind") &&
    u.HasPropertyKey(e, "inferred") &&
    u.IsEqual(e["~kind"], "ExtendsTrue") &&
    u.IsObject(e.inferred)
  );
}
function F() {
  return l.Create({ "~kind": "ExtendsFalse" }, {});
}
function AC(e) {
  return u.IsObject(e) && u.HasPropertyKey(e, "~kind") && u.IsEqual(e["~kind"], "ExtendsFalse");
}
function rr(e) {
  return Dd(e) || Fd(e);
}
function pe(e, t, n) {
  return rr(e) ? t(e.inferred) : n();
}
function MC(e, t, n, r) {
  return pe(
    Y(e, n, r),
    (o) => S(l.Assign(l.Assign(e, o), { [t]: n })),
    () => F(),
  );
}
function jC(e, t) {
  return S(e);
}
function LC(e, t, n, r, o) {
  return pe(
    Y(e, t, n),
    (i) =>
      pe(
        Y(i, t, r),
        (a) => S(a),
        () => F(),
      ),
    () =>
      pe(
        Y(e, t, o),
        (i) => S(i),
        () => F(),
      ),
  );
}
function NC(e, t, n) {
  let r = Ve(n);
  return Y(e, t, r);
}
function qd(e, t, n) {
  return u.ShiftLeft(
    n,
    (r, o) =>
      pe(
        Y(e, t, r),
        (i) => qd(i, t, o),
        () => F(),
      ),
    () => S(e),
  );
}
function DC(e, t, n) {
  let r = Je(n);
  return Y(e, t, r);
}
function Ud(e, t, n) {
  return u.ShiftLeft(
    n,
    (r, o) =>
      pe(
        Y(e, t, r),
        (i) => S(i),
        () => Ud(e, t, o),
      ),
    () => F(),
  );
}
function re(e, t, n) {
  return he(n)
    ? jC(e, t)
    : ye(n)
      ? LC(e, t, n.if, n.then, n.else)
      : Fe(n)
        ? NC(e, t, n.enum)
        : we(n)
          ? MC(e, n.name, t, n.extends)
          : V(n)
            ? qd(e, t, n.allOf)
            : be(n)
              ? DC(e, t, n.pattern)
              : P(n)
                ? Ud(e, t, n.anyOf)
                : Ee(n)
                  ? S(e)
                  : F();
}
function Kd(e, t, n) {
  return we(n) ? re(e, t, n) : he(n) ? S(e) : Ee(n) ? S(e) : Os(e);
}
function FC(e, t) {
  let n = Sn(e),
    r = Sn(t);
  return (n && r) || (!n && r) ? !0 : !(n && !r);
}
function Bd(e, t, n, r) {
  return le(r) ? (FC(t, r) ? Y(e, n, r.items) : F()) : re(e, t, r);
}
function Jd(e, t, n) {
  return At(n) ? S(e) : re(e, t, n);
}
function Gd(e, t, n) {
  return pt(n) ? S(e) : re(e, t, n);
}
function qC(e, t, n, r, o) {
  let i = we(r) ? t : r,
    a = we(r) ? r : t,
    c = Be(t),
    m = Be(r);
  return !c && m
    ? F()
    : pe(
        Y(e, i, a),
        (p) => Wr(p, n, o),
        () => F(),
      );
}
function UC(e, t, n, r) {
  return u.ShiftLeft(
    r,
    (o, i) => qC(e, t, n, o, i),
    () => (Be(t) ? S(e) : F()),
  );
}
function KC(e, t, n) {
  return u.ShiftLeft(
    t,
    (r, o) => UC(e, r, o, n),
    () => S(e),
  );
}
function Wr(e, t, n) {
  return KC(e, t, n);
}
function Si(e, t, n) {
  return Mt(n) ? S(e) : Y(e, t, n);
}
function zd(e, t, n, r) {
  return he(r)
    ? S(e)
    : Ee(r)
      ? S(e)
      : Re(r)
        ? pe(
            Wr(e, t, r.parameters),
            (o) => Si(o, n, r.instanceType),
            () => F(),
          )
        : F();
}
function Hd(e, t, n, r, o) {
  return pe(
    Y(e, t, o),
    () => Y(e, n, o),
    () => Y(e, r, o),
  );
}
function Wd(e, t, n) {
  let r = Ve(t);
  return Y(e, r, n);
}
function Vd(e, t, n, r) {
  return he(r)
    ? S(e)
    : Ee(r)
      ? S(e)
      : Oe(r)
        ? pe(
            Wr(e, t, r.parameters),
            (o) => Si(o, n, r.returnType),
            () => F(),
          )
        : F();
}
function Xd(e, t, n) {
  return He(n) ? S(e) : $e(n) ? S(e) : re(e, t, n);
}
function Yd(e, t, n) {
  let r = fe(t);
  return Y(e, r, n);
}
function ki(e, t, n) {
  return t === n ? S(e) : F();
}
function BC(e, t, n) {
  return ne(n) ? ki(e, t, n.const) : At(n) ? S(e) : re(e, X(t), n);
}
function JC(e, t, n) {
  return ne(n) ? ki(e, t, n.const) : pt(n) ? S(e) : re(e, X(t), n);
}
function GC(e, t, n) {
  return ne(n) ? ki(e, t, n.const) : $e(n) ? S(e) : re(e, X(t), n);
}
function zC(e, t, n) {
  return ne(n) ? ki(e, t, n.const) : We(n) ? S(e) : re(e, X(t), n);
}
function Qd(e, t, n) {
  return u.IsBigInt(t.const)
    ? BC(e, t.const, n)
    : u.IsBoolean(t.const)
      ? JC(e, t.const, n)
      : u.IsNumber(t.const)
        ? GC(e, t.const, n)
        : u.IsString(t.const)
          ? zC(e, t.const, n)
          : ke();
}
function Zd(e, t, n) {
  return we(n) ? re(e, t, n) : S(e);
}
function el(e, t, n) {
  return Hn(n) ? S(e) : re(e, t, n);
}
function tl(e, t, n) {
  return $e(n) ? S(e) : re(e, t, n);
}
function HC(e, t, n) {
  return Be(t) ? (Be(n) ? S(e) : F()) : S(e);
}
function WC(e, t, n) {
  return we(n) && xt(n.extends)
    ? F()
    : pe(
        Y(e, t, n),
        (r) => HC(r, t, n),
        () => F(),
      );
}
function VC(e, t) {
  return e.reduce((n, r) => (r in t ? (rr(t[r]) ? { ...n, ...t[r].inferred } : ke()) : ke()), {});
}
function XC(e, t, n) {
  let r = {};
  for (let a of u.Keys(n))
    r[a] =
      a in t
        ? WC({}, t[a], n[a])
        : Be(n[a])
          ? we(n[a])
            ? S(l.Assign(e, { [n[a].name]: n[a].extends }))
            : S(e)
          : F();
  let o = u.Values(r).every((a) => rr(a)),
    i = o ? VC(u.Keys(r), r) : {};
  return o ? S(i) : F();
}
function YC(e, t, n) {
  let r = XC(e, t, n);
  return rr(r) ? S(l.Assign(e, r.inferred)) : F();
}
function QC(e, t, n) {
  return YC(e, t, n);
}
function ZC(e, t) {
  return u.Keys(t).reduce(
    (n, r) => ({
      ...n,
      [r]: u.HasPropertyKey(e, r) ? (P(n[r]) ? B([...n[r].anyOf, t[r]]) : B([e[r], t[r]])) : t[r],
    }),
    e,
  );
}
function nl(e, t, n, r) {
  return u.ShiftLeft(
    t,
    (o, i) =>
      pe(
        Y({}, e[o], n),
        (a) => nl(e, i, n, ZC(r, a)),
        () => F(),
      ),
    () => S(r),
  );
}
function eE(e, t, n, r) {
  let o = u.Keys(t);
  return nl(t, o, r, e);
}
function rl(e, t, n) {
  return Ue(n) ? eE(e, t, ft(n), Xe(n)) : te(n) ? QC(e, t, n.properties) : re(e, N(t), n);
}
function tE(e, t) {
  return u.IsEqual(u.Keys(t).length, 0) ? S(e) : F();
}
function nE(e, t, n, r, o) {
  return Y(e, n, o);
}
function ol(e, t, n, r) {
  return Ue(r)
    ? nE(e, Vo(t), n, Vo(ft(r)), Xe(r))
    : te(r)
      ? tE(e, r.properties)
      : he(r)
        ? S(e)
        : Ee(r)
          ? S(e)
          : F();
}
function il(e, t, n) {
  return We(n) ? S(e) : re(e, t, n);
}
function sl(e, t, n) {
  return rn(n) ? S(e) : re(e, t, n);
}
function al(e, t, n) {
  let r = Je(t);
  return Y(e, r, n);
}
function Ps(e, t) {
  return l.Create({ "~kind": "Inferrable" }, { name: e, type: t }, {});
}
function Vr(e) {
  return (
    u.IsObject(e) &&
    u.HasPropertyKey(e, "~kind") &&
    u.HasPropertyKey(e, "name") &&
    u.HasPropertyKey(e, "type") &&
    u.IsEqual(e["~kind"], "Inferrable") &&
    u.IsString(e.name) &&
    u.IsObject(e.type)
  );
}
function As(e) {
  return un(e)
    ? we(e.items)
      ? le(e.items.extends)
        ? Ps(e.items.name, e.items.extends.items)
        : Ee(e.items.extends)
          ? Ps(e.items.name, e.items.extends)
          : void 0
      : ke()
    : void 0;
}
function _i(e) {
  return we(e) ? Ps(e.name, e.extends) : void 0;
}
function Ms(e, t, n = []) {
  return u.ShiftLeft(
    e,
    (r, o) =>
      pe(
        Y({}, r, t),
        () => Ms(o, t, [...n, r]),
        () => {},
      ),
    () => n,
  );
}
function ul(e, t, n, r) {
  let o = Ms(n, r);
  return u.IsArray(o) ? S(l.Assign(e, { [t]: Te(o) })) : F();
}
function Ri(e, t, n, r) {
  let o = Ms(n, r);
  return u.IsArray(o) ? S(l.Assign(e, { [t]: B(o) })) : F();
}
function rE(e) {
  return [...e].reverse();
}
function js(e, t) {
  return t ? rE(e) : e;
}
function oE(e) {
  let t = e.length > 0 ? e[0] : void 0,
    n = Se(t) ? As(t) : void 0;
  return Se(n);
}
function iE(e, t, n, r, o, i) {
  return pe(
    Y(e, n, o),
    (a) => cl(a, t, r, i),
    () => F(),
  );
}
function sE(e, t, n, r, o) {
  let i = As(r);
  return Vr(i)
    ? ul(e, i.name, js(n, t), i.type)
    : u.ShiftLeft(
        n,
        (a, c) => iE(e, t, a, c, r, o),
        () => F(),
      );
}
function aE(e, t, n, r) {
  return u.ShiftLeft(
    r,
    (o, i) => sE(e, t, n, o, i),
    () => (u.IsEqual(n.length, 0) ? S(e) : F()),
  );
}
function cl(e, t, n, r) {
  return aE(e, t, n, r);
}
function uE(e, t, n) {
  let r = dn(e, ce([], []), n),
    o = oE(r);
  return cl(e, o, js(t, o), js(r, o));
}
function ml(e, t, n) {
  let r = _i(n);
  return Vr(r)
    ? Ri(e, r.name, t, r.type)
    : u.ShiftLeft(
        t,
        (o, i) =>
          pe(
            Y(e, o, n),
            (a) => ml(a, i, n),
            () => F(),
          ),
        () => S(e),
      );
}
function pl(e, t, n) {
  let r = dn(e, ce([], []), t);
  return ue(n) ? uE(e, r, n.items) : le(n) ? ml(e, r, n.items) : re(e, Te(r), n);
}
function dl(e, t, n) {
  return Mt(n) ? S(e) : Zn(n) ? S(e) : re(e, t, n);
}
function ll(e, t, n) {
  return u.ShiftLeft(
    n,
    (r, o) =>
      pe(
        Y(e, t, r),
        (i) => S(i),
        () => ll(e, t, o),
      ),
    () => F(),
  );
}
function Ls(e, t, n) {
  return u.ShiftLeft(
    t,
    (r, o) =>
      pe(
        ll(e, r, n),
        (i) => Ls(i, o, n),
        () => F(),
      ),
    () => S(e),
  );
}
function fl(e, t, n) {
  let r = _i(n);
  return Vr(r) ? Ri(e, r.name, t, r.type) : P(n) ? Ls(e, t, n.anyOf) : Ls(e, t, [n]);
}
function gl(e, t, n) {
  return we(n) ? re(e, t, n) : he(n) ? S(e) : Ee(n) ? S(e) : F();
}
function hl(e, t, n) {
  return Mt(n) ? S(e) : re(e, t, n);
}
function Y(e, t, n) {
  return he(t)
    ? Kd(e, t, n)
    : le(t)
      ? Bd(e, t, t.items, n)
      : At(t)
        ? Jd(e, t, n)
        : pt(t)
          ? Gd(e, t, n)
          : Re(t)
            ? zd(e, t.parameters, t.instanceType, n)
            : ye(t)
              ? Hd(e, t.if, t.then, t.else, n)
              : Fe(t)
                ? Wd(e, t.enum, n)
                : Oe(t)
                  ? Vd(e, t.parameters, t.returnType, n)
                  : He(t)
                    ? Xd(e, t, n)
                    : V(t)
                      ? Yd(e, t.allOf, n)
                      : ne(t)
                        ? Qd(e, t, n)
                        : xt(t)
                          ? Zd(e, t, n)
                          : Hn(t)
                            ? el(e, t, n)
                            : $e(t)
                              ? tl(e, t, n)
                              : te(t)
                                ? rl(e, t.properties, n)
                                : Ue(t)
                                  ? ol(e, ft(t), Xe(t), n)
                                  : We(t)
                                    ? il(e, t, n)
                                    : rn(t)
                                      ? sl(e, t, n)
                                      : be(t)
                                        ? al(e, t.pattern, n)
                                        : ue(t)
                                          ? pl(e, t.items, n)
                                          : Zn(t)
                                            ? dl(e, t, n)
                                            : P(t)
                                              ? fl(e, t.anyOf, n)
                                              : Ee(t)
                                                ? gl(e, t, n)
                                                : Mt(t)
                                                  ? hl(e, t, n)
                                                  : F();
}
function cE(e, t) {
  return fe([...e, N(t)]);
}
function Ns(e, t, n) {
  return U(e) ? l.Update(cE(e, t), {}, n) : Ur(e, t, n);
}
function xl(e, t, n, r, o) {
  let i = at(e, t, n),
    a = Xr(e, t, r);
  return Ns(i, a, o);
}
function Ur(e, t, n = {}) {
  return A("Interface", [e, t], n);
}
function or(e) {
  return Se(e) && u.HasPropertyKey(e, "action") && u.IsEqual(e.action, "Interface");
}
function yl(e, t, n = {}) {
  return Ns(e, t, n);
}
function mE(e, t, n) {
  return e.includes(n) ? !0 : Yr([...e, n], t, t[n]);
}
function bl(e, t, n) {
  let r = Ao(n);
  return Mn(e, t, r);
}
function Mn(e, t, n) {
  return u.ShiftLeft(
    n,
    (r, o) => (Yr(e, t, r) ? !0 : Mn(e, t, o)),
    () => !1,
  );
}
function Yr(e, t, n) {
  return Pe(n)
    ? mE(e, t, n.$ref)
    : le(n)
      ? Yr(e, t, n.items)
      : Re(n)
        ? Mn(e, t, [...n.parameters, n.instanceType])
        : Oe(n)
          ? Mn(e, t, [...n.parameters, n.returnType])
          : or(n)
            ? bl(e, t, n.parameters[1])
            : V(n)
              ? Mn(e, t, n.allOf)
              : te(n)
                ? bl(e, t, n.properties)
                : P(n)
                  ? Mn(e, t, n.anyOf)
                  : ue(n)
                    ? Mn(e, t, n.items)
                    : Ue(n)
                      ? Yr(e, t, Xe(n))
                      : !1;
}
function Il(e, t, n) {
  return Yr(e, t, n);
}
function pE(e, t) {
  return t.reduce((n, r) => (Il([r], e, e[r]) ? [...n, r] : n), []);
}
function Cl(e) {
  let t = Po(e);
  return pE(e, t);
}
function dE(e, t, n) {
  return n.includes(t) ? n : t in e ? Qr(e, e[t], [...n, t]) : ke();
}
function El(e, t, n) {
  let r = Ao(t);
  return ir(e, r, n);
}
function ir(e, t, n) {
  return t.reduce((r, o) => Qr(e, o, r), n);
}
function Qr(e, t, n) {
  return Pe(t)
    ? dE(e, t.$ref, n)
    : le(t)
      ? Qr(e, t.items, n)
      : Re(t)
        ? ir(e, [...t.parameters, t.instanceType], n)
        : Oe(t)
          ? ir(e, [...t.parameters, t.returnType], n)
          : or(t)
            ? El(e, t.parameters[1], n)
            : V(t)
              ? ir(e, t.allOf, n)
              : te(t)
                ? El(e, t.properties, n)
                : P(t)
                  ? ir(e, t.anyOf, n)
                  : ue(t)
                    ? ir(e, t.items, n)
                    : Ue(t)
                      ? Qr(e, Xe(t), n)
                      : n;
}
function wl(e, t, n) {
  return Qr(e, n, [t]);
}
function lE(e) {
  return Jn();
}
function fE(e) {
  return u.Keys(e).reduce((t, n) => ({ ...t, [n]: jn(e[n]) }), {});
}
function Zr(e) {
  return e.reduce((t, n) => [...t, jn(n)], []);
}
function jn(e) {
  return Pe(e)
    ? lE(e.$ref)
    : le(e)
      ? st(jn(e.items), Oo(e))
      : Re(e)
        ? St(Zr(e.parameters), jn(e.instanceType))
        : Oe(e)
          ? kt(Zr(e.parameters), jn(e.returnType))
          : V(e)
            ? Ye(Zr(e.allOf))
            : te(e)
              ? N(fE(e.properties))
              : Ue(e)
                ? Wo(Yn(e), jn(Xe(e)))
                : P(e)
                  ? B(Zr(e.anyOf))
                  : ue(e)
                    ? Te(Zr(e.items))
                    : e;
}
function gE(e, t) {
  return t in e ? jn(e[t]) : je();
}
function $l(e) {
  return gE(e.$defs, e.$ref);
}
function hE(e, t, n) {
  let r = at(e, ce([], []), t),
    o = Xr({}, ce([], []), n);
  return fe([...r, N(o)]);
}
function xE(e, t) {
  return u
    .Keys(e)
    .filter((r) => t.includes(r))
    .reduce((r, o) => {
      let i = e[o],
        a = or(i) ? hE(e, i.parameters[0], i.parameters[1]) : i;
      return { ...r, [o]: a };
    }, {});
}
function Tl(e, t, n) {
  let r = wl(e, t, n),
    o = xE(e, r);
  return Rt(o, t);
}
function vl(e, t) {
  return t in e ? (Pe(e[t]) ? vl(e, e[t].$ref) : e[t]) : oe();
}
function jt(e, t) {
  return vl(e, t);
}
function Sl(e) {
  return De(e) ? $l(e) : Mo(e) ? je() : e;
}
function qe(e, t, n) {
  let r = Sl(t),
    o = Sl(n);
  return Y(e, r, o);
}
var Lr = 0,
  Oi = 1,
  Nr = 2,
  Go = 3;
function Dr(e, t) {
  let n = [qe({}, e, t), qe({}, t, e)];
  return D.IsExtendsTrueLike(n[0]) && D.IsExtendsTrueLike(n[1])
    ? Lr
    : D.IsExtendsTrueLike(n[0]) && D.IsExtendsFalse(n[1])
      ? Nr
      : D.IsExtendsFalse(n[0]) && D.IsExtendsTrueLike(n[1])
        ? Go
        : Oi;
}
function Ds(e, t, n = [], r = t) {
  return u.ShiftLeft(
    t,
    (o, i) => {
      let a = Dr(e, o);
      return u.IsEqual(a, Nr) || u.IsEqual(a, Lr)
        ? r
        : u.IsEqual(a, Oi)
          ? Ds(e, i, [...n, o], r)
          : Ds(e, i, n, r);
    },
    () => [...n, e],
  );
}
function yE(e, t, n) {
  let r = lt(e);
  return he(r) ? [r] : Ee(r) ? [r] : xt(r) ? Pi(t, n) : te(r) ? Pi(t, [...n, r]) : Pi(t, Ds(r, n));
}
function Pi(e, t = []) {
  return u.ShiftLeft(
    e,
    (n, r) => yE(n, r, t),
    () => t,
  );
}
function gs(e) {
  let t = Pi(e);
  return Xn(t);
}
function Fs(e, t) {
  return l.Update(lt(e), {}, t);
}
function kl(e, t, n, r) {
  let o = w(e, t, n);
  return Fs(o, r);
}
function eo(e, t = []) {
  return tn(e) && u.IsEqual(e.action, "Conditional")
    ? Pe(e.parameters[0])
      ? eo(e.parameters[2], eo(e.parameters[3], [...t, e.parameters[0].$ref]))
      : eo(e.parameters[2], eo(e.parameters[3], t))
    : tn(e) &&
        u.IsEqual(e.action, "Mapped") &&
        tn(e.parameters[1]) &&
        u.IsEqual(e.parameters[1].action, "KeyOf") &&
        Pe(e.parameters[1].parameters[0])
      ? [...t, e.parameters[1].parameters[0].$ref]
      : t;
}
function bE(e, t) {
  return e.reduce((n, r) => [...n, t.includes(r.name)], []);
}
function Ol(e, t, n = []) {
  return u.ShiftLeft(
    e,
    (r, o) =>
      u.ShiftLeft(
        t,
        (i, a) => Ol(o, a, [...n, [i, r]]),
        () => n,
      ),
    () => n,
  );
}
function IE(e) {
  return be(e) ? Je(e.pattern) : Fe(e) ? Ve(e.enum) : e;
}
function CE(e) {
  let t = IE(e);
  return P(t) ? [...t.anyOf] : [t];
}
function EE(e, t) {
  return e.reduce((n, r) => [...n, [...r, t]], []);
}
function _l(e, t) {
  return t.reduce((n, r) => [...n, ...EE(e, r)], []);
}
function Rl(e) {
  return e.reduce((t, n) => (u.IsEqual(n[0], !0) ? _l(t, CE(n[1])) : _l(t, [n[1]])), [[]]);
}
function Pl(e, t, n) {
  let r = eo(n),
    o = bE(e, r),
    i = Ol(t, o);
  return (tn(n) && u.IsEqual(n.action, "Conditional")) || (tn(n) && u.IsEqual(n.action, "Mapped"))
    ? Rl(i)
    : [t];
}
function wE() {
  return ["(not-resolvable)", oe()];
}
function $E() {
  return ["(not-generic)", oe()];
}
function TE(e, t, n) {
  return [e, nn(t, n)];
}
function vE(e, t, n) {
  return t in e ? Al(e, t, e[t], n) : wE();
}
function Al(e, t, n, r) {
  return Bn(n) ? TE(t, n.parameters, n.expression) : Pe(n) ? vE(e, n.$ref, r) : $E();
}
function Ml(e, t, n) {
  return Al(e, "(anonymous)", t, n);
}
function SE(e, t, n) {
  if (we(t) || sr(t) || D.IsExtendsTrueLike(qe({}, t, n))) return;
  let r = { parameter: e, expect: n, actual: t };
  throw new Error(`Argument for parameter ${e} does not satisfy constraint`, { cause: r });
}
function jl(e, t, n, r, o) {
  let i = w(e, t, o);
  return (SE(n, i, r), l.Assign(e, { [n]: i }));
}
function kE(e, t, n, r, o) {
  let i = w(e, t, n.extends),
    a = w(e, t, n.equals);
  return u.ShiftLeft(
    o,
    (c, m) => qs(jl(e, t, n.name, i, c), t, r, m),
    () => qs(jl(e, t, n.name, i, a), t, r, []),
  );
}
function qs(e, t, n, r) {
  return u.ShiftLeft(
    n,
    (o, i) => kE(e, t, o, i, r),
    () => e,
  );
}
function Ll(e, t, n, r) {
  return qs(e, t, n, r);
}
var Us = 0,
  Ks = 0;
function _E() {
  if (!u.IsLessThan(Ks, Gt.Get().maxInstantiationCount))
    throw Error("Type instantiation is excessively deep and possibly infinite");
}
function RE() {
  (_E(), Ks++, Us++);
}
function OE() {
  (Us--, u.IsEqual(Us, 0) && (Ks = 0));
}
function PE(e) {
  return u.IsGreaterThan(e.callstack.length, 0) ? e.callstack[e.callstack.length - 1] : "";
}
function AE(e, t) {
  return u.IsEqual(PE(e), t);
}
function ME(e, t, n, r, o, i) {
  RE();
  try {
    let a = Ll(e, t, r, i),
      c = w(a, ce([...t.callstack, n.$ref], t.visited), o);
    return w(a, ce([], []), c);
  } finally {
    OE();
  }
}
function jE(e, t, n, r, o, i) {
  return i.reduce((a, c) => {
    let m = ME(e, t, n, r, o, c);
    return [...a, m];
  }, []);
}
function LE(e, t, n, r, o, i) {
  let a = Pl(r, i, o),
    c = jE(e, t, n, r, o, a);
  return u.IsEqual(c.length, 1) ? c[0] : Ze(c);
}
function Ai(e, t, n, r) {
  let o = at(e, t, r),
    i = Ml(e, n, r),
    a = i[0],
    c = i[1];
  return Bn(c)
    ? AE(t, a)
      ? Kr(zt(a), o)
      : LE(e, t, zt(a), c.parameters, c.expression, o)
    : Kr(n, o);
}
function Kr(e, t) {
  return l.Create({ "~kind": "Call" }, { type: "call", target: e, arguments: t }, {});
}
function Nl(e, t) {
  return Ai({}, ce([], []), e, t);
}
function sr(e) {
  return R(e, "Call");
}
function NE(e) {
  return l.Discard(e, ["~immutable"]);
}
function Dl(e, t) {
  return l.Update(NE(e), {}, t);
}
function Fl(e, t, n, r) {
  let o = w(e, t, n);
  return Dl(o, r);
}
function ql(e, t) {
  return e(t);
}
function Ul(e, t) {
  return u.IsString(t) ? X(ql(e, t)) : X(t);
}
function Kl(e, t) {
  let n = Je(t);
  return Wt(e, n);
}
function Bl(e, t) {
  let n = t.map((r) => Wt(e, r));
  return B(n);
}
function Wt(e, t) {
  return ne(t) ? Ul(e, t.const) : be(t) ? Kl(e, t.pattern) : P(t) ? Bl(e, t.anyOf) : t;
}
function ei(e, t = {}) {
  return A("Capitalize", [e], t);
}
function Jl(e, t = {}) {
  return Bs(e, t);
}
function ti(e, t = {}) {
  return A("Lowercase", [e], t);
}
function Gl(e, t = {}) {
  return Js(e, t);
}
function ni(e, t = {}) {
  return A("Uncapitalize", [e], t);
}
function zl(e, t = {}) {
  return Gs(e, t);
}
function ri(e, t = {}) {
  return A("Uppercase", [e], t);
}
function Hl(e, t = {}) {
  return zs(e, t);
}
var DE = (e) => e[0].toUpperCase() + e.slice(1),
  FE = (e) => e.toLowerCase(),
  qE = (e) => e[0].toLowerCase() + e.slice(1),
  UE = (e) => e.toUpperCase();
function Bs(e, t) {
  return U([e]) ? l.Update(Wt(DE, e), {}, t) : ei(e, t);
}
function Js(e, t) {
  return U([e]) ? l.Update(Wt(FE, e), {}, t) : ti(e, t);
}
function Gs(e, t) {
  return U([e]) ? l.Update(Wt(qE, e), {}, t) : ni(e, t);
}
function zs(e, t) {
  return U([e]) ? l.Update(Wt(UE, e), {}, t) : ri(e, t);
}
function Wl(e, t, n, r) {
  let o = w(e, t, n);
  return Bs(o, r);
}
function Vl(e, t, n, r) {
  let o = w(e, t, n);
  return Js(o, r);
}
function Xl(e, t, n, r) {
  let o = w(e, t, n);
  return Gs(o, r);
}
function Yl(e, t, n, r) {
  let o = w(e, t, n);
  return zs(o, r);
}
function oi(e, t, n, r, o = {}) {
  return A("Conditional", [e, t, n, r], o);
}
function Ql(e, t, n, r, o = {}) {
  return Hs({}, ce([], []), e, t, n, r, o);
}
function KE(e, t, n, r, o, i) {
  let a = qe(e, n, r);
  return D.IsExtendsUnion(a)
    ? B([w(a.inferred, t, o), w(e, t, i)])
    : D.IsExtendsTrue(a)
      ? w(a.inferred, t, o)
      : w(e, t, i);
}
function Hs(e, t, n, r, o, i, a) {
  return U([n, r]) ? l.Update(KE(e, t, n, r, o, i), {}, a) : oi(n, r, o, i, a);
}
function Zl(e, t, n, r, o, i, a) {
  let c = w(e, t, n),
    m = w(e, t, r);
  return Hs(e, t, c, m, o, i, a);
}
function ii(e, t = {}) {
  return A("ConstructorParameters", [e], t);
}
function ef(e, t = {}) {
  return Ws(e, t);
}
function BE(e) {
  let t = Re(e) ? e.parameters : [],
    n = dn({}, ce([], []), t);
  return Te(n);
}
function Ws(e, t) {
  return U([e]) ? l.Update(BE(e), {}, t) : ii(e, t);
}
function tf(e, t, n, r) {
  let o = w(e, t, n);
  return Ws(o, r);
}
function si(e, t, n = {}) {
  return A("Exclude", [e, t], n);
}
function nf(e, t, n = {}) {
  return to(e, t, n);
}
function to(e, t, n) {
  return U([e, t]) ? l.Update(zo(e, t), {}, n) : si(e, t, n);
}
function rf(e, t, n, r, o) {
  let i = w(e, t, n),
    a = w(e, t, r);
  return to(i, a, o);
}
function ai(e, t, n = {}) {
  return A("Extract", [e, t], n);
}
function of(e, t, n = {}) {
  return Vs(e, t, n);
}
function JE(e, t) {
  let n = qe({}, e, t);
  return D.IsExtendsTrueLike(n) ? [e] : [];
}
function sf(e, t, n = []) {
  return u.ShiftLeft(
    e,
    (r, o) => sf(o, t, [...n, ...JE(r, t)]),
    () => n,
  );
}
function af(e, t) {
  let n = lt(e),
    r = P(n) ? n.anyOf : [n],
    o = sf(r, t);
  return Ze(o);
}
function Vs(e, t, n) {
  return U([e, t]) ? l.Update(af(e, t), {}, n) : ai(e, t, n);
}
function uf(e, t, n, r, o) {
  let i = w(e, t, n),
    a = w(e, t, r);
  return Vs(i, a, o);
}
function GE(e) {
  return e.reduce((t, n) => (Fo(n) ? [...t, X(n)] : t), []);
}
function ar(e) {
  let t = GE(e);
  return B(t);
}
function Br(e, t, n = {}) {
  return A("Index", [e, t], n);
}
function cf(e, t, n = {}) {
  let r = u.IsArray(t) ? ar(t) : t;
  return Xs(e, r, n);
}
function mf(e, t) {
  let n = jt(e, t);
  return ut(n);
}
function pf(e, t, n) {
  let r = bt(e, t, n);
  return ut(r);
}
function zE(e, t) {
  let n = u.Keys(e).filter((d) => !u.HasPropertyKey(t, d)),
    r = u.Keys(t).filter((d) => !u.HasPropertyKey(e, d)),
    o = u.Keys(e).filter((d) => u.HasPropertyKey(t, d)),
    i = n.reduce((d, g) => ({ ...d, [g]: e[g] }), {}),
    a = r.reduce((d, g) => ({ ...d, [g]: t[g] }), {}),
    c = o.reduce((d, g) => ({ ...d, [g]: fe([e[g], t[g]]) }), {}),
    m = l.Assign(i, a);
  return l.Assign(m, c);
}
function df(e) {
  return e.reduce((t, n) => zE(t, ut(n)), {});
}
function lf(e) {
  let t = gc(Te(e));
  return ut(t);
}
function HE(e, t) {
  return u
    .Keys(e)
    .filter((o) => o in t)
    .reduce((o, i) => ({ ...o, [i]: Ze([e[i], t[i]]) }), {});
}
function ff(e, t) {
  return u.ShiftLeft(
    e,
    (n, r) => ff(r, HE(t, ut(n))),
    () => t,
  );
}
function gf(e) {
  return u.ShiftLeft(
    e,
    (t, n) => ff(n, ut(t)),
    () => ke(),
  );
}
function ut(e) {
  return De(e)
    ? mf(e.$defs, e.$ref)
    : ye(e)
      ? pf(e.if, e.then, e.else)
      : V(e)
        ? df(e.allOf)
        : P(e)
          ? gf(e.anyOf)
          : ue(e)
            ? lf(e.items)
            : te(e)
              ? e.properties
              : {};
}
function ur(e) {
  let t = ut(e);
  return N(t);
}
var WE = new RegExp("^(?:0|[1-9][0-9]*)$");
function cr(e) {
  let t = `${e}`;
  return WE.test(t) ? parseInt(t) : e;
}
function VE(e) {
  return X(cr(e));
}
function hf(e) {
  return e.map((t) => xf(t));
}
function xf(e) {
  return V(e) ? Ye(hf(e.allOf)) : P(e) ? B(hf(e.anyOf)) : ne(e) ? VE(e.const) : e;
}
function yf(e, t) {
  let n = xf(t),
    r = qe({}, n, ot());
  return D.IsExtendsTrueLike(r) ? e : ne(t) && u.IsEqual(t.const, "length") ? ot() : oe();
}
function bf(e, t) {
  let n = jt(e, t);
  return it(n);
}
function If(e, t, n) {
  let r = bt(e, t, n);
  return it(r);
}
function Cf(e) {
  let t = Ve(e);
  return it(t);
}
function Ef(e) {
  let t = fe(e);
  return it(t);
}
function wf(e) {
  return [`${e}`];
}
function $f(e) {
  let t = Je(e);
  return it(t);
}
function Tf(e) {
  return e.reduce((t, n) => [...t, ...it(n)], []);
}
function it(e) {
  return De(e)
    ? bf(e.$defs, e.$ref)
    : ye(e)
      ? If(e.if, e.then, e.else)
      : Fe(e)
        ? Cf(e.enum)
        : V(e)
          ? Ef(e.allOf)
          : ne(e)
            ? wf(e.const)
            : be(e)
              ? $f(e.pattern)
              : P(e)
                ? Tf(e.anyOf)
                : [];
}
function mr(e) {
  return it(e);
}
function no(e, t) {
  return t.map((n) => ro(e, n));
}
function ro(e, t) {
  return le(t)
    ? st(ro(e, t.items))
    : Re(t)
      ? St(no(e, t.parameters), ro(e, t.instanceType))
      : Oe(t)
        ? kt(no(e, t.parameters), ro(e, t.returnType))
        : ue(t)
          ? Te(no(e, t.items))
          : P(t)
            ? B(no(e, t.anyOf))
            : V(t)
              ? Ye(no(e, t.allOf))
              : Yo(t)
                ? N(e)
                : t;
}
function vf(e, t) {
  return ro(e, t);
}
function XE(e, t) {
  let n = t in e ? e[t] : oe();
  return vf(e, n);
}
function Sf(e, t) {
  return t.reduce((n, r) => [...n, XE(e, r)], []);
}
function YE(e, t) {
  let n = mr(t),
    r = Sf(e, n);
  return Ze(r);
}
var QE = new RegExp(an);
function ZE(e) {
  return e.filter((n) => QE.test(n));
}
function ew(e) {
  let t = Po(e),
    n = ZE(t),
    r = Sf(e, n);
  return Ze(r);
}
function kf(e, t) {
  return $e(t) ? ew(e) : YE(e, t);
}
function tw(e) {
  return X(cr(e));
}
function _f(e) {
  return e.map((t) => Ys(t));
}
function Ys(e) {
  return V(e) ? Ye(_f(e.allOf)) : P(e) ? B(_f(e.anyOf)) : ne(e) ? tw(e.const) : e;
}
function nw(e, t) {
  return e.reduceRight((n, r, o) => {
    let i = qe({}, X(o), t);
    return D.IsExtendsTrueLike(i) ? [r, ...n] : n;
  }, []);
}
function rw(e, t) {
  let n = Ys(t),
    r = nw(e, n);
  return on(r);
}
function ow(e) {
  return on(e);
}
function Rf(e, t) {
  return ne(t) && u.IsEqual(t.const, "length") ? X(e.length) : $e(t) || He(t) ? ow(e) : rw(e, t);
}
function Of(e, t) {
  return le(e) ? yf(e.items, t) : te(e) ? kf(e.properties, t) : ue(e) ? Rf(e.items, t) : oe();
}
function iw(e) {
  return De(e) || ye(e) || V(e) || P(e) ? ur(e) : e;
}
function Xs(e, t, n) {
  return U([e, t]) ? l.Update(Of(iw(e), t), {}, n) : Br(e, t, n);
}
function Pf(e, t, n, r, o) {
  let i = w(e, t, n),
    a = w(e, t, r);
  return Xs(i, a, o);
}
function ui(e, t = {}) {
  return A("InstanceType", [e], t);
}
function Af(e, t = {}) {
  return Qs(e, t);
}
function sw(e) {
  return Re(e) ? e.instanceType : oe();
}
function Qs(e, t) {
  return U([e]) ? l.Update(sw(e), {}, t) : ui(e, t);
}
function Mf(e, t, n, r = {}) {
  let o = w(e, t, n);
  return Qs(o, r);
}
function Jr(e, t = {}) {
  return A("KeyOf", [e], t);
}
function jf(e, t = {}) {
  return Zs(e, t);
}
function Lf() {
  return B([ot(), dt(), Wn()]);
}
function Nf(e) {
  return ot();
}
function aw(e) {
  return e.reduce((n, r) => (Fo(r) ? [...n, X(cr(r))] : ke()), []);
}
function Df(e) {
  let t = u.Keys(e),
    n = aw(t);
  return on(n);
}
function Ff(e) {
  return Yn(e);
}
function qf(e) {
  let t = e.map((n, r) => X(r));
  return on(t);
}
function Uf(e) {
  return he(e)
    ? Lf()
    : le(e)
      ? Nf(e.items)
      : te(e)
        ? Df(e.properties)
        : Ue(e)
          ? Ff(e)
          : ue(e)
            ? qf(e.items)
            : oe();
}
function uw(e) {
  return De(e) || ye(e) || V(e) || P(e) ? ur(e) : e;
}
function Zs(e, t) {
  return U([e]) ? l.Update(Uf(uw(e)), {}, t) : Jr(e, t);
}
function Kf(e, t, n, r) {
  let o = w(e, t, n);
  return Zs(o, r);
}
function qr(e, t, n, r, o = {}) {
  return A("Mapped", [e, t, n, r], o);
}
function Bf(e, t, n, r, o = {}) {
  return ea({}, ce([], []), e, t, n, r, o);
}
function cw(e) {
  let t = Je(e);
  return Mi(t);
}
function mw(e) {
  return e.reduce((t, n) => [...t, ...Mi(n)], []);
}
function pw(e) {
  let t = Ve(e);
  return Mi(t);
}
function dw(e) {
  return u.IsNumber(e) ? [X(`${e}`)] : [X(e)];
}
function Mi(e) {
  return Fe(e)
    ? pw(e.enum)
    : ne(e)
      ? dw(e.const)
      : be(e)
        ? cw(e.pattern)
        : P(e)
          ? mw(e.anyOf)
          : [e];
}
function Jf(e) {
  return Mi(e);
}
function lw(e) {
  return be(e) ? Je(e.pattern) : e;
}
function fw(e, t, n, r, o, i) {
  let a = l.Assign(e, { [n.name]: r }),
    c = w(a, t, o),
    m = lw(c),
    p = w(a, t, i);
  return Vu(m) || Xu(m) ? { [m.const]: p } : {};
}
function gw(e, t, n, r, o, i) {
  return r.reduce((a, c) => [...a, fw(e, t, n, c, o, i)], []);
}
function hw(e) {
  return e.reduce((t, n) => [...t, N(n)], []);
}
function Gf(e, t, n, r, o, i) {
  let a = Jf(r),
    c = gw(e, t, n, a, o, i),
    m = hw(c);
  return fe(m);
}
function ea(e, t, n, r, o, i, a) {
  return U([r]) ? l.Update(Gf(e, t, n, r, o, i), {}, a) : qr(n, r, o, i, a);
}
function zf(e, t, n, r, o, i, a) {
  let c = w(e, t, r);
  return ea(e, t, n, c, o, i, a);
}
function xw(e, t, n) {
  let r = l.Assign(e, t);
  return u
    .Keys(t)
    .filter((i) => n.includes(i))
    .reduce((i, a) => ({ ...i, [a]: Tl(r, a, t[a]) }), {});
}
function yw(e, t, n) {
  let r = l.Assign(e, t);
  return u
    .Keys(t)
    .filter((i) => !n.includes(i))
    .reduce((i, a) => ({ ...i, [a]: w(r, ce([], []), t[a]) }), {});
}
function bw(e, t, n) {
  let r = Cl(t),
    o = xw(e, t, r),
    i = yw(e, t, r),
    a = { ...o, ...i };
  return l.Update(a, {}, n);
}
function ji(e, t, n, r) {
  return bw(e, n, r);
}
function ci(e, t = {}) {
  return A("NonNullable", [e], t);
}
function Hf(e, t = {}) {
  return ta(e, t);
}
function Iw(e) {
  let t = B([zn(), Qn()]);
  return to(e, t, {});
}
function ta(e, t) {
  return U([e]) ? l.Update(Iw(e), {}, t) : ci(e, t);
}
function Wf(e, t, n, r) {
  let o = w(e, t, n);
  return ta(o, r);
}
function mi(e, t, n = {}) {
  return A("Omit", [e, t], n);
}
function Vf(e, t, n = {}) {
  let r = u.IsArray(t) ? ar(t) : t;
  return na(e, r, n);
}
function Li(e) {
  let t = ur(e);
  return te(t) ? t.properties : ke();
}
function Cw(e, t) {
  return u.Keys(e).reduce((r, o) => (t.includes(o) ? r : { ...r, [o]: e[o] }), {});
}
function Xf(e, t) {
  let n = Li(e),
    r = mr(t),
    o = Cw(n, r);
  return N(o);
}
function na(e, t, n) {
  return U([e, t]) ? l.Update(Xf(e, t), {}, n) : mi(e, t, n);
}
function Yf(e, t, n, r, o) {
  let i = w(e, t, n),
    a = w(e, t, r);
  return na(i, a, o);
}
function pi(e, t = {}) {
  return A("Parameters", [e], t);
}
function Qf(e, t = {}) {
  return ra(e, t);
}
function Ew(e) {
  let t = Oe(e) ? e.parameters : [],
    n = dn({}, ce([], []), t);
  return Te(n);
}
function ra(e, t) {
  return U([e]) ? l.Update(Ew(e), {}, t) : pi(e, t);
}
function Zf(e, t, n, r) {
  let o = w(e, t, n);
  return ra(o, r);
}
function di(e, t = {}) {
  return A("Partial", [e], t);
}
function eg(e, t = {}) {
  return oa(e, t);
}
function tg(e, t) {
  let n = jt(e, t),
    r = Lt(n);
  return Rt(l.Assign(e, { [t]: r }), t);
}
function ng(e, t, n) {
  let r = bt(e, t, n);
  return Lt(r);
}
function rg(e) {
  let t = fe(e);
  return Lt(t);
}
function og(e) {
  let t = e.map((n) => Lt(n));
  return B(t);
}
function ig(e) {
  let t = u.Keys(e).reduce((r, o) => ({ ...r, [o]: Tn(e[o]) }), {});
  return N(t);
}
function Lt(e) {
  return De(e)
    ? tg(e.$defs, e.$ref)
    : ye(e)
      ? ng(e.if, e.then, e.else)
      : V(e)
        ? rg(e.allOf)
        : P(e)
          ? og(e.anyOf)
          : te(e)
            ? ig(e.properties)
            : N({});
}
function oa(e, t) {
  return U([e]) ? l.Update(Lt(e), {}, t) : di(e, t);
}
function sg(e, t, n, r) {
  let o = w(e, t, n);
  return oa(o, r);
}
function li(e, t, n = {}) {
  return A("Pick", [e, t], n);
}
function ag(e, t, n = {}) {
  let r = u.IsArray(t) ? ar(t) : t;
  return ia(e, r, n);
}
function ww(e, t) {
  return u.Keys(e).reduce((r, o) => (t.includes(o) ? l.Assign(r, { [o]: e[o] }) : r), {});
}
function ug(e, t) {
  let n = Li(e),
    r = mr(t),
    o = ww(n, r);
  return N(o);
}
function ia(e, t, n) {
  return U([e, t]) ? l.Update(ug(e, t), {}, n) : li(e, t, n);
}
function cg(e, t, n, r, o) {
  let i = w(e, t, n),
    a = w(e, t, r);
  return ia(i, a, o);
}
function fi(e, t = {}) {
  return A("ReadonlyObject", [e], t);
}
function sa(e, t = {}) {
  return aa(e, t);
}
var mg = sa;
function pg(e) {
  return Gn(st(e));
}
function dg(e, t) {
  let n = jt(e, t),
    r = Nt(n);
  return Rt(l.Assign(e, { [t]: r }), t);
}
function lg(e, t, n) {
  let r = bt(e, t, n);
  return Nt(r);
}
function fg(e) {
  let t = fe(e);
  return Nt(t);
}
function gg(e) {
  let t = u.Keys(e).reduce((r, o) => ({ ...r, [o]: kn(e[o]) }), {});
  return N(t);
}
function hg(e) {
  return Gn(Te(e));
}
function xg(e) {
  let t = e.map((n) => Nt(n));
  return B(t);
}
function Nt(e) {
  return le(e)
    ? pg(e.items)
    : De(e)
      ? dg(e.$defs, e.$ref)
      : ye(e)
        ? lg(e.if, e.then, e.else)
        : V(e)
          ? fg(e.allOf)
          : te(e)
            ? gg(e.properties)
            : ue(e)
              ? hg(e.items)
              : P(e)
                ? xg(e.anyOf)
                : e;
}
function aa(e, t) {
  return U([e]) ? l.Update(Nt(e), {}, t) : fi(e);
}
function yg(e, t, n, r) {
  let o = w(e, t, n);
  return aa(o, r);
}
function bg(e, t, n, r) {
  return t.visited.includes(r) ? n : r in e ? w(e, ce(t.callstack, [...t.visited, r]), e[r]) : n;
}
function Ig(e, t) {
  let n = jt(e, t),
    r = Dt(n);
  return Rt(l.Assign(e, { [t]: r }), t);
}
function Cg(e, t, n) {
  let r = bt(e, t, n);
  return Dt(r);
}
function Eg(e) {
  let t = fe(e);
  return Dt(t);
}
function wg(e) {
  let t = e.map((n) => Dt(n));
  return B(t);
}
function $g(e) {
  let t = u.Keys(e).reduce((r, o) => ({ ...r, [o]: Jo(e[o]) }), {});
  return N(t);
}
function Dt(e) {
  return De(e)
    ? Ig(e.$defs, e.$ref)
    : ye(e)
      ? Cg(e.if, e.then, e.else)
      : V(e)
        ? Eg(e.allOf)
        : P(e)
          ? wg(e.anyOf)
          : te(e)
            ? $g(e.properties)
            : N({});
}
function gi(e, t = {}) {
  return A("Required", [e], t);
}
function Tg(e, t = {}) {
  return ua(e, t);
}
function ua(e, t) {
  return U([e]) ? l.Update(Dt(e), {}, t) : gi(e, t);
}
function vg(e, t, n, r) {
  let o = w(e, t, n);
  return ua(o, r);
}
function hi(e, t = {}) {
  return A("ReturnType", [e], t);
}
function Sg(e, t = {}) {
  return ca(e, t);
}
function $w(e) {
  return Oe(e) ? e.returnType : oe();
}
function ca(e, t) {
  return U([e]) ? l.Update($w(e), {}, t) : hi(e, t);
}
function kg(e, t, n, r = {}) {
  let o = w(e, t, n);
  return ca(o, r);
}
function xi(e, t) {
  return A("With", [e, t], {});
}
function _g(e, t) {
  return ma(e, t);
}
function ma(e, t) {
  return U([e]) ? l.Update(e, {}, t) : xi(e, t);
}
function Rg(e, t, n, r) {
  let o = w(e, t, n);
  return ma(o, r);
}
function Tw(e) {
  return un(e)
    ? ue(e.items)
      ? pa(e.items.items)
      : we(e.items)
        ? [e]
        : Pe(e.items)
          ? [e]
          : [oe()]
    : [e];
}
function pa(e) {
  return e.reduce((n, r) => [...n, ...Tw(r)], []);
}
function ce(e, t) {
  return { callstack: e, visited: t };
}
function U(e) {
  return u.ShiftLeft(
    e,
    (t, n) => (Pe(t) ? !1 : U(n)),
    () => !0,
  );
}
function Xr(e, t, n) {
  return u.Keys(n).reduce((r, o) => ({ ...r, [o]: w(e, t, n[o]) }), {});
}
function dn(e, t, n) {
  let r = at(e, t, n);
  return pa(r);
}
function at(e, t, n) {
  return n.map((r) => w(e, t, r));
}
function vw(e, t) {
  let n = Be(e) ? _r(t, {}) : t,
    r = _n(e) ? kr(n, {}) : n;
  return Sn(e) ? oo(r, {}) : r;
}
function Sw(e, t, n, r, o) {
  return u.IsEqual(n, "AddImmutable")
    ? Og(e, t, r[0], o)
    : u.IsEqual(n, "RemoveImmutable")
      ? Fl(e, t, r[0], o)
      : u.IsEqual(n, "AddReadonly")
        ? $u(e, t, r[0], o)
        : u.IsEqual(n, "RemoveReadonly")
          ? mc(e, t, r[0], o)
          : u.IsEqual(n, "AddOptional")
            ? Tu(e, t, r[0], o)
            : u.IsEqual(n, "RemoveOptional")
              ? lc(e, t, r[0], o)
              : u.IsEqual(n, "Capitalize")
                ? Wl(e, t, r[0], o)
                : u.IsEqual(n, "Conditional")
                  ? Zl(e, t, r[0], r[1], r[2], r[3], o)
                  : u.IsEqual(n, "ConstructorParameters")
                    ? tf(e, t, r[0], o)
                    : u.IsEqual(n, "Evaluate")
                      ? kl(e, t, r[0], o)
                      : u.IsEqual(n, "Exclude")
                        ? rf(e, t, r[0], r[1], o)
                        : u.IsEqual(n, "Extract")
                          ? uf(e, t, r[0], r[1], o)
                          : u.IsEqual(n, "Index")
                            ? Pf(e, t, r[0], r[1], o)
                            : u.IsEqual(n, "InstanceType")
                              ? Mf(e, t, r[0], o)
                              : u.IsEqual(n, "Interface")
                                ? xl(e, t, r[0], r[1], o)
                                : u.IsEqual(n, "KeyOf")
                                  ? Kf(e, t, r[0], o)
                                  : u.IsEqual(n, "Lowercase")
                                    ? Vl(e, t, r[0], o)
                                    : u.IsEqual(n, "Mapped")
                                      ? zf(e, t, r[0], r[1], r[2], r[3], o)
                                      : u.IsEqual(n, "Module")
                                        ? ji(e, t, r[0], o)
                                        : u.IsEqual(n, "NonNullable")
                                          ? Wf(e, t, r[0], o)
                                          : u.IsEqual(n, "Pick")
                                            ? cg(e, t, r[0], r[1], o)
                                            : u.IsEqual(n, "Parameters")
                                              ? Zf(e, t, r[0], o)
                                              : u.IsEqual(n, "Partial")
                                                ? sg(e, t, r[0], o)
                                                : u.IsEqual(n, "Omit")
                                                  ? Yf(e, t, r[0], r[1], o)
                                                  : u.IsEqual(n, "ReadonlyObject")
                                                    ? yg(e, t, r[0], o)
                                                    : u.IsEqual(n, "Record")
                                                      ? Rc(e, t, r[0], r[1], o)
                                                      : u.IsEqual(n, "Required")
                                                        ? vg(e, t, r[0], o)
                                                        : u.IsEqual(n, "ReturnType")
                                                          ? kg(e, t, r[0], o)
                                                          : u.IsEqual(n, "TemplateLiteral")
                                                            ? jd(e, t, r[0], o)
                                                            : u.IsEqual(n, "Uncapitalize")
                                                              ? Xl(e, t, r[0], o)
                                                              : u.IsEqual(n, "Uppercase")
                                                                ? Yl(e, t, r[0], o)
                                                                : u.IsEqual(n, "With")
                                                                  ? Rg(e, t, r[0], r[1])
                                                                  : A(n, r, o);
}
function kw(e, t, n) {
  let r = Pe(n)
    ? bg(e, t, n, n.$ref)
    : le(n)
      ? st(w(e, t, n.items), Oo(n))
      : sr(n)
        ? Ai(e, t, n.target, n.arguments)
        : Re(n)
          ? St(at(e, t, n.parameters), w(e, t, n.instanceType), vu(n))
          : Oe(n)
            ? kt(at(e, t, n.parameters), w(e, t, n.returnType), Su(n))
            : ye(n)
              ? vn(w(e, t, n.if), w(e, t, n.then), w(e, t, n.else), Au(n))
              : V(n)
                ? Ye(at(e, t, n.allOf), Du(n))
                : te(n)
                  ? N(Xr(e, t, n.properties), Ou(n))
                  : Ue(n)
                    ? Oc(ft(n), w(e, t, Xe(n)))
                    : un(n)
                      ? Pn(w(e, t, n.items))
                      : ue(n)
                        ? Te(dn(e, t, n.items), cc(n))
                        : P(n)
                          ? B(at(e, t, n.anyOf), Qu(n))
                          : n;
  return vw(n, r);
}
function w(e, t, n) {
  return tn(n) ? Sw(e, t, n.action, n.parameters, n.options) : kw(e, t, n);
}
function da(e, t) {
  return w(e, ce([], []), t);
}
function _w(e) {
  return l.Update(e, { "~immutable": !0 }, {});
}
function oo(e, t) {
  return l.Update(_w(e), {}, t);
}
function Og(e, t, n, r) {
  let o = w(e, t, n);
  return oo(o, r);
}
function Op(e, t = {}) {
  return A("AddImmutable", [e], t);
}
function Gn(e, t = {}) {
  return oo(e, t);
}
function Pp(e, t = {}) {
  return A("Evaluate", [e], t);
}
function Pg(e, t = {}) {
  return Fs(e, t);
}
function Ap(e, t = {}) {
  return A("Module", [e], t);
}
function Ag(e, t = {}) {
  return ji({}, ce([], []), e, t);
}
function Mg(...e) {
  let [t, n, r] = Ot.Match(e, {
      2: (a, c) => (u.IsString(a) ? [{}, a, c] : [a, c, {}]),
      3: (a, c, m) => [a, c, m],
      1: (a) => [{}, a, {}],
    }),
    o = Rd(n),
    i = u.IsArray(o) && u.IsEqual(o.length, 2) ? w(t, ce([], []), o[0]) : oe();
  return l.Update(i, {}, r);
}
var C = {};
En(C, {
  Any: () => Jn,
  Array: () => st,
  BigInt: () => Ar,
  Boolean: () => No,
  Call: () => Nl,
  Capitalize: () => Jl,
  Codec: () => Lo,
  Conditional: () => Ql,
  Constructor: () => St,
  ConstructorParameters: () => ef,
  Cyclic: () => Rt,
  Decode: () => Ku,
  DecodeBuilder: () => Pr,
  Dependent: () => vn,
  Encode: () => Bu,
  EncodeBuilder: () => Or,
  Enum: () => Nu,
  Evaluate: () => Pg,
  Exclude: () => nf,
  Extends: () => qe,
  ExtendsResult: () => D,
  Extract: () => of,
  Function: () => kt,
  Generic: () => nn,
  Identifier: () => Mr,
  Immutable: () => Ju,
  Index: () => cf,
  Infer: () => Rr,
  InstanceType: () => Af,
  Instantiate: () => da,
  Integer: () => Rn,
  Interface: () => yl,
  Intersect: () => Ye,
  IsAny: () => he,
  IsArray: () => le,
  IsBigInt: () => At,
  IsBoolean: () => pt,
  IsCall: () => sr,
  IsCodec: () => jo,
  IsConstructor: () => Re,
  IsCyclic: () => De,
  IsDependent: () => ye,
  IsEnum: () => Fe,
  IsEnumValue: () => Lu,
  IsFunction: () => Oe,
  IsGeneric: () => Bn,
  IsIdentifier: () => Wu,
  IsImmutable: () => Sn,
  IsInfer: () => we,
  IsInteger: () => He,
  IsIntersect: () => V,
  IsKind: () => R,
  IsLiteral: () => ne,
  IsNever: () => xt,
  IsNull: () => Hn,
  IsNumber: () => $e,
  IsObject: () => te,
  IsOptional: () => Be,
  IsParameter: () => Yu,
  IsReadonly: () => _n,
  IsRecord: () => Ue,
  IsRef: () => Pe,
  IsRefine: () => us,
  IsRest: () => un,
  IsSchema: () => Se,
  IsString: () => We,
  IsSymbol: () => rn,
  IsTemplateLiteral: () => be,
  IsThis: () => Yo,
  IsTuple: () => ue,
  IsUndefined: () => Zn,
  IsUnion: () => P,
  IsUnknown: () => Ee,
  IsUnsafe: () => Mo,
  IsVoid: () => Mt,
  KeyOf: () => jf,
  Literal: () => X,
  Lowercase: () => Gl,
  Mapped: () => Bf,
  Module: () => Ag,
  Never: () => oe,
  NonNullable: () => Hf,
  Null: () => zn,
  Number: () => ot,
  Object: () => N,
  Omit: () => Vf,
  Optional: () => _u,
  Parameter: () => On,
  Parameters: () => Qf,
  Partial: () => eg,
  Pick: () => ag,
  Readonly: () => Gu,
  ReadonlyObject: () => sa,
  ReadonlyType: () => mg,
  Record: () => Wo,
  RecordKey: () => Yn,
  RecordPattern: () => ft,
  RecordValue: () => Xe,
  Ref: () => zt,
  Refine: () => zu,
  Required: () => Tg,
  Rest: () => Pn,
  ReturnType: () => Sg,
  Script: () => Mg,
  String: () => dt,
  Symbol: () => Wn,
  TemplateLiteral: () => Nd,
  This: () => Xo,
  Tuple: () => Te,
  Uncapitalize: () => zl,
  Undefined: () => Qn,
  Union: () => B,
  Unknown: () => je,
  Unsafe: () => Pu,
  Uppercase: () => Hl,
  Void: () => Qo,
  With: () => _g,
});
import { isUtf8 as R$ } from "node:buffer";
import { createHash as uh, randomUUID as O$ } from "node:crypto";
import { spawn as P$ } from "node:child_process";
import { EventEmitter as A$ } from "node:events";
import { createConnection as M$ } from "node:net";
var _ = class extends Error {
    code;
    constructor(t, n) {
      (super(`cue-shell error [${t}]: ${n}`), (this.name = "CueError"), (this.code = t));
    }
  },
  ct = class extends Error {
    constructor(t) {
      (super(t), (this.name = "CueTransportError"));
    }
  },
  io = class extends ct {
    constructor(t) {
      (super(t), (this.name = "CueDaemonStartingError"));
    }
  };
function la(e) {
  return e instanceof ct;
}
function fa(e, t) {
  if (e instanceof ct && !t) return e;
  let n = e instanceof Error ? e.message : String(e);
  return new ct(t ? `${t}: ${n}` : n);
}
function It(e, t) {
  let n = t instanceof Error ? ` Detail: ${t.message}` : "";
  return new _("UNSUPPORTED_PROTOCOL", `${e}.${n}`);
}
import { Buffer as Rw } from "node:buffer";
var Ow = new Set(["Pending", "Running", "Done", "Failed", "Killed"]),
  Pw = new Set(["User", "ChainAborted", "Timeout"]),
  Aw = new Set(["scheduled", "paused", "completed", "expired", "failed"]),
  Mw = new Set(["stream", "fg"]),
  jw = new Set(["done", "failed"]),
  Lw = new Set(["running", "done", "failed"]),
  Ng = new Set(["stdout", "stderr"]),
  Nw = new Set(["utf8", "base64"]),
  Dw = new Set(["Command", "Param", "Id", "Path", "Operator"]),
  Fw = new Set([
    "CommandPrefix",
    "CommandName",
    "ModeParam",
    "Operator",
    "IdRef",
    "Word",
    "String",
    "Number",
    "Error",
  ]);
function Dg(e, t = "response.payload.Ok") {
  let [n, r] = zg(e, t);
  switch (n) {
    case "Ack":
      J(r, `${t}.Ack`, []);
      break;
    case "ScriptCreated":
      qw(r, `${t}.ScriptCreated`);
      break;
    case "ScriptInfo":
      Uw(r, `${t}.ScriptInfo`);
      break;
    case "JobCreated":
      Kw(r, `${t}.JobCreated`);
      break;
    case "ChainCreated":
      Bw(r, `${t}.ChainCreated`);
      break;
    case "CronAdded":
      Ln(r, `${t}.CronAdded`, "cron_id");
      break;
    case "ScopeCreated":
      Jw(r, `${t}.ScopeCreated`);
      break;
    case "JobInfo":
      ga(r, `${t}.JobInfo`);
      break;
    case "JobList":
      Ft(r, `${t}.JobList`, ga);
      break;
    case "JobListPage":
      xa(r, `${t}.JobListPage`, "jobs", ga);
      break;
    case "CronList":
      Ft(r, `${t}.CronList`, jg);
      break;
    case "CronListPage":
      xa(r, `${t}.CronListPage`, "crons", jg);
      break;
    case "ScopeInfo":
      ha(r, `${t}.ScopeInfo`);
      break;
    case "ScopeList":
      Ft(r, `${t}.ScopeList`, ha);
      break;
    case "ScopeListPage":
      xa(r, `${t}.ScopeListPage`, "scopes", ha);
      break;
    case "Output":
      Vw(r, `${t}.Output`);
      break;
    case "JobOutput":
      Yw(r, `${t}.JobOutput`);
      break;
    case "EvalText":
      Ln(r, `${t}.EvalText`, "text");
      break;
    case "TextOutput":
      Xw(r, `${t}.TextOutput`);
      break;
    case "CompletionList":
      Qw(r, `${t}.CompletionList`);
      break;
    case "HighlightResult":
      e$(r, `${t}.HighlightResult`);
      break;
    case "FgAttached":
      Ln(r, `${t}.FgAttached`, "id");
      break;
    case "Pong":
      n$(r, `${t}.Pong`);
      break;
    default:
      throw _e(t, `unknown protocol variant ${n}`);
  }
  return e;
}
function Fg(e, t = "event.payload") {
  let [n, r] = zg(e, t);
  switch (n) {
    case "JobStateChanged":
      r$(r, `${t}.JobStateChanged`);
      break;
    case "JobCreated":
      o$(r, `${t}.JobCreated`);
      break;
    case "ChainProgress":
      i$(r, `${t}.ChainProgress`);
      break;
    case "ScriptItemCreated":
      s$(r, `${t}.ScriptItemCreated`);
      break;
    case "ScriptFinished":
      a$(r, `${t}.ScriptFinished`);
      break;
    case "JobRemoved":
      Ln(r, `${t}.JobRemoved`, "job_id");
      break;
    case "CronTriggered":
      u$(r, `${t}.CronTriggered`);
      break;
    case "CronRemoved":
      Ln(r, `${t}.CronRemoved`, "cron_id");
      break;
    case "OutputChunk":
      c$(r, `${t}.OutputChunk`);
      break;
    case "OutputChunkBinary":
      m$(r, `${t}.OutputChunkBinary`);
      break;
    case "OutputEof":
      Ln(r, `${t}.OutputEof`, "id");
      break;
    case "FgOutput":
      p$(r, `${t}.FgOutput`);
      break;
    case "FgExited":
      d$(r, `${t}.FgExited`);
      break;
    case "ShuttingDown":
      Ln(r, `${t}.ShuttingDown`, "reason");
      break;
    default:
      throw _e(t, `unknown protocol variant ${n}`);
  }
  return e;
}
function qg(e, t = "response.payload.Err") {
  let n = J(e, t, ["code", "message"]);
  return (j(n, "code", t), j(n, "message", t), e);
}
function qw(e, t) {
  let n = J(e, t, ["script_id", "source", "items", "submit_error"]);
  (j(n, "script_id", t),
    zw(n.source, `${t}.source`),
    Ft(n.items, `${t}.items`, ba),
    Nn(n.submit_error, `${t}.submit_error`, Ug));
}
function Uw(e, t) {
  let n = J(e, t, [
    "script_id",
    "status",
    "items",
    "exit_code",
    "failed_item_index",
    "submit_error",
  ]);
  (j(n, "script_id", t),
    Xt(n, "status", t, Lw),
    Ft(n.items, `${t}.items`, ba),
    Nn(n.exit_code, `${t}.exit_code`, Ea),
    qt(n, "failed_item_index", t),
    Nn(n.submit_error, `${t}.submit_error`, Ug));
}
function Kw(e, t) {
  let n = J(e, t, [
    "job_id",
    "start_scope",
    "open_hint",
    "chain_id",
    "chain_index",
    "chain_total",
    "warnings",
  ]);
  (j(n, "job_id", t),
    et(n, "start_scope", t),
    Di(n, "open_hint", t),
    et(n, "chain_id", t),
    qt(n, "chain_index", t),
    qt(n, "chain_total", t),
    so(n, "warnings", t));
}
function Bw(e, t) {
  let n = J(e, t, ["chain_id", "job_ids", "chain", "warnings"]);
  (j(n, "chain_id", t), so(n, "job_ids", t), ya(n.chain, `${t}.chain`), so(n, "warnings", t));
}
function Jw(e, t) {
  let n = J(e, t, ["hash", "summary"]);
  (j(n, "hash", t), j(n, "summary", t));
}
function ga(e, t) {
  let n = J(
    e,
    t,
    [
      "id",
      "status",
      "pipeline",
      "exit_code",
      "start_scope",
      "end_scope",
      "open_hint",
      "chain_id",
      "chain_index",
      "chain_total",
    ],
    ["pending_reason"],
  );
  (j(n, "id", t),
    Ni(n.status, `${t}.status`),
    j(n, "pipeline", t),
    Nn(n.exit_code, `${t}.exit_code`, Ea),
    et(n, "start_scope", t),
    et(n, "end_scope", t),
    Di(n, "open_hint", t),
    et(n, "chain_id", t),
    qt(n, "chain_index", t),
    qt(n, "chain_total", t),
    "pending_reason" in n && j(n, "pending_reason", t));
}
function jg(e, t) {
  let n = J(e, t, ["id", "schedule", "command", "status"]);
  (j(n, "id", t), j(n, "schedule", t), j(n, "command", t), Xt(n, "status", t, Aw));
}
function ha(e, t) {
  let n = J(e, t, ["hash", "parent", "cwd", "env_count"]);
  (j(n, "hash", t), et(n, "parent", t), j(n, "cwd", t), Vt(n, "env_count", t));
}
function ya(e, t) {
  let n = J(e, t, ["id", "pipeline", "total_jobs", "jobs"]);
  (j(n, "id", t), j(n, "pipeline", t), Vt(n, "total_jobs", t), Ft(n.jobs, `${t}.jobs`, Gw));
}
function Gw(e, t) {
  let n = J(e, t, [
    "index",
    "pipeline",
    "status",
    "job_id",
    "start_scope",
    "end_scope",
    "open_hint",
  ]);
  (Vt(n, "index", t),
    j(n, "pipeline", t),
    Ni(n.status, `${t}.status`),
    et(n, "job_id", t),
    et(n, "start_scope", t),
    et(n, "end_scope", t),
    Nn(n.open_hint, `${t}.open_hint`, Kg));
}
function ba(e, t) {
  let n = J(e, t, ["index", "source", "result"]);
  (Vt(n, "index", t), j(n, "source", t), Hw(n.result, `${t}.result`));
}
function zw(e, t) {
  let n = Fi(e, t);
  if (!Object.hasOwn(n, "kind")) throw _e(`${t}.kind`, "missing field kind");
  let r = j(n, "kind", t);
  if (r === "inline") {
    J(n, t, ["kind"]);
    return;
  }
  if (r === "file") {
    let o = J(n, t, ["kind", "path"]);
    j(o, "path", t);
    return;
  }
  throw _e(`${t}.kind`, `unknown script source ${r}`);
}
function Hw(e, t) {
  let n = Fi(e, t);
  if (!Object.hasOwn(n, "kind")) throw _e(`${t}.kind`, "missing field kind");
  let r = j(n, "kind", t);
  switch (r) {
    case "job": {
      let o = J(n, t, ["kind", "job_id", "start_scope", "open_hint"]);
      (j(o, "job_id", t), et(o, "start_scope", t), Di(o, "open_hint", t));
      return;
    }
    case "chain": {
      let o = J(n, t, ["kind", "chain_id", "job_ids", "chain"]);
      (j(o, "chain_id", t), so(o, "job_ids", t), ya(o.chain, `${t}.chain`));
      return;
    }
    case "cron": {
      let o = J(n, t, ["kind", "cron_id"]);
      j(o, "cron_id", t);
      return;
    }
    case "message": {
      let o = J(n, t, ["kind", "text"]);
      j(o, "text", t);
      return;
    }
    default:
      throw _e(`${t}.kind`, `unknown script item result ${r}`);
  }
}
function Ug(e, t) {
  let n = J(e, t, ["index", "source", "code", "message"]);
  (Vt(n, "index", t), j(n, "source", t), j(n, "code", t), j(n, "message", t));
}
function Ww(e, t) {
  let n = J(e, t, ["total", "shown", "limit", "truncated"]);
  (Vt(n, "total", t), Vt(n, "shown", t), qt(n, "limit", t), pr(n, "truncated", t));
}
function xa(e, t, n, r) {
  let o = J(e, t, [n, "page"]);
  (Ft(o[n], `${t}.${n}`, r), Ww(o.page, `${t}.page`));
}
function Vw(e, t) {
  let n = J(e, t, ["id", "data", "truncated"], ["encoding", "base64"]);
  (j(n, "id", t), j(n, "data", t), pr(n, "truncated", t), Ia(n, t));
}
function Xw(e, t) {
  let n = J(e, t, ["text", "truncated"], ["encoding", "base64"]);
  (j(n, "text", t), pr(n, "truncated", t), Ia(n, t));
}
function Lg(e, t) {
  let n = J(e, t, ["data", "truncated"], ["encoding", "base64"]);
  (j(n, "data", t), pr(n, "truncated", t), Ia(n, t));
}
function Ia(e, t) {
  if (("encoding" in e ? Xt(e, "encoding", t, Nw) : "utf8") === "base64") {
    if (!("base64" in e)) throw _e(`${t}.base64`, "missing field base64");
    Ca(e.base64, `${t}.base64`);
    return;
  }
  if ("base64" in e) throw _e(`${t}.base64`, "base64 is only valid when encoding is base64");
}
function Yw(e, t) {
  let n = J(e, t, ["id", "stdout", "stderr", "stderr_pty_merged"]);
  (j(n, "id", t),
    Lg(n.stdout, `${t}.stdout`),
    Lg(n.stderr, `${t}.stderr`),
    pr(n, "stderr_pty_merged", t));
}
function Qw(e, t) {
  let n = J(e, t, ["items"]);
  Ft(n.items, `${t}.items`, Zw);
}
function Zw(e, t) {
  let n = J(e, t, ["label", "insert_text", "kind", "detail"]);
  (j(n, "label", t), j(n, "insert_text", t), Xt(n, "kind", t, Dw), et(n, "detail", t));
}
function e$(e, t) {
  let n = J(e, t, ["spans"]);
  Ft(n.spans, `${t}.spans`, t$);
}
function t$(e, t) {
  let n = J(e, t, ["start", "end", "kind"]);
  (Vt(n, "start", t), Vt(n, "end", t), Xt(n, "kind", t, Fw));
}
function n$(e, t) {
  let n = J(
    e,
    t,
    ["version", "protocol_version", "capabilities"],
    ["instance_id", "generation_id", "ready"],
  );
  (j(n, "version", t),
    l$(n, "protocol_version", t),
    so(n, "capabilities", t),
    n.instance_id !== void 0 && j(n, "instance_id", t),
    n.generation_id !== void 0 && j(n, "generation_id", t),
    n.ready !== void 0 && pr(n, "ready", t));
}
function r$(e, t) {
  let n = J(e, t, ["job_id", "old_state", "new_state", "end_scope", "chain_id", "chain_index"]);
  (j(n, "job_id", t),
    Ni(n.old_state, `${t}.old_state`),
    Ni(n.new_state, `${t}.new_state`),
    et(n, "end_scope", t),
    et(n, "chain_id", t),
    qt(n, "chain_index", t));
}
function o$(e, t) {
  let n = J(e, t, [
    "job_id",
    "pipeline",
    "start_scope",
    "open_hint",
    "chain_id",
    "chain_index",
    "chain_total",
  ]);
  (j(n, "job_id", t),
    j(n, "pipeline", t),
    et(n, "start_scope", t),
    Di(n, "open_hint", t),
    et(n, "chain_id", t),
    qt(n, "chain_index", t),
    qt(n, "chain_total", t));
}
function i$(e, t) {
  let n = J(e, t, ["chain"]);
  ya(n.chain, `${t}.chain`);
}
function s$(e, t) {
  let n = J(e, t, ["script_id", "item"]);
  (j(n, "script_id", t), ba(n.item, `${t}.item`));
}
function a$(e, t) {
  let n = J(e, t, ["script_id", "status", "exit_code", "failed_item_index"]);
  (j(n, "script_id", t),
    Xt(n, "status", t, jw),
    Ea(n.exit_code, `${t}.exit_code`),
    qt(n, "failed_item_index", t));
}
function u$(e, t) {
  let n = J(e, t, ["cron_id", "job_id"]);
  (j(n, "cron_id", t), j(n, "job_id", t));
}
function c$(e, t) {
  let n = J(e, t, ["id", "stream", "data"]);
  (j(n, "id", t), Xt(n, "stream", t, Ng), j(n, "data", t));
}
function m$(e, t) {
  let n = J(e, t, ["id", "stream", "base64"]);
  (j(n, "id", t), Xt(n, "stream", t, Ng), Ca(n.base64, `${t}.base64`));
}
function p$(e, t) {
  let n = J(e, t, ["data"]);
  Ca(n.data, `${t}.data`);
}
function d$(e, t) {
  let n = J(e, t, ["id", "reason"]);
  (j(n, "id", t), j(n, "reason", t));
}
function Ln(e, t, n) {
  let r = J(e, t, [n]);
  j(r, n, t);
}
function Ni(e, t) {
  if (typeof e == "string") {
    if (Ow.has(e)) return;
    throw _e(t, `unknown job status ${e}`);
  }
  let n = J(e, t, ["Cancelled"]);
  Xt(n, "Cancelled", t, Pw);
}
function Kg(e, t) {
  Bg(e, t, Mw);
}
function Ca(e, t) {
  if (typeof e != "string") throw _e(t, "expected a base64 string");
  if (Rw.from(e, "base64").toString("base64") !== e) throw _e(t, "expected canonical base64");
}
function Ft(e, t, n) {
  if (!Array.isArray(e)) throw _e(t, "expected an array");
  e.forEach((r, o) => n(r, `${t}[${o}]`));
}
function Nn(e, t, n) {
  e !== null && n(e, t);
}
function Bg(e, t, n) {
  if (typeof e != "string" || !n.has(e)) throw _e(t, `expected one of ${[...n].join(", ")}`);
  return e;
}
function j(e, t, n) {
  let r = e[t];
  if (typeof r != "string") throw _e(`${n}.${t}`, "expected a string");
  return r;
}
function et(e, t, n) {
  Nn(e[t], `${n}.${t}`, Jg);
}
function so(e, t, n) {
  Ft(e[t], `${n}.${t}`, Jg);
}
function pr(e, t, n) {
  if (typeof e[t] != "boolean") throw _e(`${n}.${t}`, "expected a boolean");
}
function Vt(e, t, n) {
  Gg(e[t], `${n}.${t}`);
}
function qt(e, t, n) {
  Nn(e[t], `${n}.${t}`, Gg);
}
function l$(e, t, n) {
  wa(e[t], `${n}.${t}`, 0, 4294967295);
}
function Di(e, t, n) {
  Kg(e[t], `${n}.${t}`);
}
function Xt(e, t, n, r) {
  return Bg(e[t], `${n}.${t}`, r);
}
function Jg(e, t) {
  if (typeof e != "string") throw _e(t, "expected a string");
}
function Gg(e, t) {
  wa(e, t, 0, Number.MAX_SAFE_INTEGER);
}
function Ea(e, t) {
  wa(e, t, -2147483648, 2147483647);
}
function wa(e, t, n, r) {
  if (!Number.isSafeInteger(e) || e < n || e > r)
    throw _e(t, `expected an integer from ${n} to ${r}`);
}
function J(e, t, n, r = []) {
  let o = Fi(e, t),
    i = new Set([...n, ...r]);
  for (let a of Object.keys(o)) if (!i.has(a)) throw _e(t, `unknown field ${a}`);
  for (let a of n) if (!Object.hasOwn(o, a)) throw _e(`${t}.${a}`, `missing field ${a}`);
  return o;
}
function Fi(e, t) {
  if (!e || typeof e != "object" || Array.isArray(e)) throw _e(t, "expected an object");
  return e;
}
function zg(e, t) {
  let n = Fi(e, t),
    r = Object.keys(n);
  if (r.length !== 1) throw _e(t, "expected exactly one protocol variant");
  let o = r[0];
  return [o, n[o]];
}
function _e(e, t) {
  return new Error(`invalid cue-shell IPC message at ${e}: ${t}`);
}
import { spawn as S$ } from "node:child_process";
import { homedir as f$ } from "node:os";
import { delimiter as Hg, join as $a } from "node:path";
function dr(e = process.env) {
  let t = e.HOME?.trim() || f$(),
    n = e.CARGO_HOME?.trim() || $a(t, ".cargo"),
    r = [...(e.PATH ?? "").split(Hg), e.UV_TOOL_BIN_DIR, $a(t, ".local", "bin"), $a(n, "bin")],
    o = new Set(),
    i = r
      .map((a) => a?.trim())
      .filter((a) => typeof a == "string" && a.length > 0 && !o.has(a))
      .filter((a) => (o.add(a), !0))
      .join(Hg);
  return { ...e, PATH: i };
}
import { spawn as g$ } from "node:child_process";
import { accessSync as h$, constants as x$ } from "node:fs";
import { delimiter as y$, isAbsolute as b$, resolve as I$ } from "node:path";
var C$ = 5e3,
  Wg = 32 * 1024;
async function E$(e = {}) {
  let t = e.runner ?? w$,
    n = { env: e.env, timeoutMs: e.timeoutMs },
    r = [],
    o = await ao(t, { command: "cue", args: ["--version"] }, /^cue\s+(\S+)$/u, n);
  if ((r.push(o.result), o.identity === "cue-shell")) {
    let p = await ao(
        t,
        { command: "cue", args: ["client", "--version"] },
        /^cue-client\s+(\S+)$/u,
        n,
      ),
      d = await ao(t, { command: "cue", args: ["daemon", "--version"] }, /^Version:\s+(\S+)$/u, n);
    r.push(p.result, d.result);
    let g = o.version;
    if (
      g !== void 0 &&
      p.identity === "cue-shell" &&
      d.identity === "cue-shell" &&
      g === p.version &&
      g === d.version
    ) {
      let x = {
        status: "aggregate",
        version: g,
        client: { command: "cue", args: ["client"] },
        daemon: { command: "cue", args: ["daemon"] },
      };
      return {
        status: "aggregate",
        contract: x,
        probes: r,
        message: `cue-shell aggregate command is ready (version ${x.version})`,
      };
    }
    return {
      status: "incomplete-installation",
      probes: r,
      message: Vg(r, "cue-shell aggregate namespaces disagree"),
    };
  }
  let i = await ao(t, { command: "cue-client", args: ["--version"] }, /^cue-client\s+(\S+)$/u, n),
    a = await ao(t, { command: "cued", args: ["--version"] }, /^Version:\s+(\S+)$/u, n);
  r.push(i.result, a.result);
  let c = i.version;
  if (c !== void 0 && i.identity === "cue-shell" && a.identity === "cue-shell" && c === a.version) {
    let p = {
        status: "legacy-direct",
        version: c,
        client: { command: "cue-client", args: [] },
        daemon: { command: "cued", args: [] },
      },
      d =
        o.identity === "foreign"
          ? `using cue-shell legacy commands because ${va(o.result)} is not the cue-shell aggregate CLI`
          : `using cue-shell legacy commands (version ${p.version}); reinstall cue-shell to restore the aggregate CLI`;
    return { status: "legacy-direct", contract: p, probes: r, message: d };
  }
  let m = [i, a].some((p) => p.identity === "cue-shell");
  return o.identity === "foreign"
    ? { status: "foreign", probes: r, message: $$(r) }
    : m || [i, a].some((p) => p.identity === "failed")
      ? {
          status: "incomplete-installation",
          probes: r,
          message: Vg(r, "cue-shell direct commands disagree"),
        }
      : { status: "missing", probes: r, message: Yg(r) };
}
async function qi(e = {}) {
  let t = await E$(e);
  if (t.contract) return t.contract;
  let n = "CUE_INSTALLATION_INCOMPLETE";
  throw (
    t.status === "missing"
      ? (n = "CUE_INSTALLATION_MISSING")
      : t.status === "foreign" && (n = "CUE_COMMAND_FOREIGN"),
    new _(n, t.message)
  );
}
async function w$(e, t = {}) {
  let n = dr(t.env),
    r = v$(e.command, n);
  return new Promise((o) => {
    let i = g$(e.command, e.args, { env: n, stdio: ["ignore", "pipe", "pipe"] }),
      a = [],
      c = [],
      m = !1,
      p,
      d = (x) => {
        m || ((m = !0), p && clearTimeout(p), o(x));
      };
    (i.stdout.on("data", (x) => Xg(a, x)),
      i.stderr.on("data", (x) => Xg(c, x)),
      i.on("error", (x) =>
        d({
          command: e.command,
          args: e.args,
          ...(r ? { executablePath: r } : {}),
          code: null,
          signal: null,
          stdout: lr(a),
          stderr: lr(c),
          error: { ...(x.code ? { code: x.code } : {}), message: x.message },
        }),
      ),
      i.on("close", (x, I) =>
        d({
          command: e.command,
          args: e.args,
          ...(r ? { executablePath: r } : {}),
          code: x,
          signal: I,
          stdout: lr(a),
          stderr: lr(c),
        }),
      ));
    let g = t.timeoutMs ?? C$;
    g > 0 &&
      ((p = setTimeout(() => {
        (i.kill("SIGTERM"),
          d({
            command: e.command,
            args: e.args,
            ...(r ? { executablePath: r } : {}),
            code: null,
            signal: "SIGTERM",
            stdout: lr(a),
            stderr: lr(c),
            error: { message: `timed out after ${g}ms` },
          }));
      }, g)),
      p.unref?.());
  });
}
async function ao(e, t, n, r) {
  let o = await e(t, r);
  if (o.error?.code === "ENOENT") return { result: o, identity: "missing" };
  if (o.error || o.code !== 0) return { result: o, identity: "failed" };
  let i = n.exec(o.stdout.trim());
  return i
    ? { result: o, version: i[1], identity: "cue-shell" }
    : { result: o, identity: "foreign" };
}
function Yg(e) {
  return [
    "cue-shell is required for command execution but was not found.",
    Ta(e),
    "Install it with:",
    "  uv tool install cue-shell",
  ].join(`
`);
}
function Vg(e, t) {
  return [
    `cue-shell installation is incomplete: ${t}.`,
    Ta(e),
    "Repair the installation through its original owner. For uv installs:",
    "  uv tool install --reinstall cue-shell",
  ].join(`
`);
}
function $$(e) {
  let t = e[0];
  return t
    ? [
        "the `cue` command on PATH is not the cue-shell aggregate CLI, and no complete legacy cue-shell command set was found.",
        `Found: ${va(t)}`,
        Ta(e),
        "Install cue-shell in a user bin directory that does not overwrite the existing command:",
        "  uv tool install cue-shell",
      ].join(`
`)
    : Yg(e);
}
function Ta(e) {
  return ["Probed commands:", ...e.map((t) => `  ${va(t)}`)].join(`
`);
}
function va(e) {
  let t = [e.command, ...e.args].join(" "),
    n = e.executablePath ?? "<not found on PATH>",
    r = e.stdout.trim() || e.stderr.trim(),
    o = e.error?.message ?? r;
  return `${t} -> ${n}${o ? ` (${T$(o)})` : ""}`;
}
function T$(e) {
  return e.split(/\r?\n/u, 1)[0]?.slice(0, 240) ?? "";
}
function v$(e, t) {
  let n = [];
  if (b$(e)) n.push(e);
  else for (let r of (t.PATH ?? "").split(y$)) r && n.push(I$(r, e));
  for (let r of n)
    try {
      return (h$(r, x$.X_OK), r);
    } catch {}
}
function Xg(e, t) {
  e.push(Buffer.from(t));
  let n = e.reduce((r, o) => r + o.length, 0);
  for (; n > Wg && e.length > 0;) {
    let r = e[0];
    if (!r) break;
    let o = n - Wg;
    r.length <= o ? (e.shift(), (n -= r.length)) : ((e[0] = r.subarray(o)), (n -= o));
  }
}
function lr(e) {
  return Buffer.concat(e).toString("utf8").trim();
}
async function Dn() {
  let e = Qg("PI_CUE_RESOLVER_TIMEOUT_MS", Sa),
    t = await qi({ timeoutMs: e }),
    n = t.client.command,
    r = [...t.client.args, "target", "resolve", "--json"];
  try {
    let o = await k$({ command: n, args: r });
    return _$(o, `${n} ${r.join(" ")}`);
  } catch (o) {
    throw new _(
      "TRANSPORT_RESOLVE_FAILED",
      `failed to resolve cue-shell client transport via ${t.status} command ${n} ${r.join(" ")}: ${o.message}`,
    );
  }
}
var Sa = 1e4,
  ka = 1e4;
function k$(e) {
  return new Promise((t, n) => {
    let r = S$(e.command, e.args, { env: dr(), stdio: ["ignore", "pipe", "pipe"] }),
      o = [],
      i = [],
      a = Qg("PI_CUE_RESOLVER_TIMEOUT_MS", Sa),
      c = !1,
      m,
      p = (d) => {
        c || ((c = !0), m && clearTimeout(m), d());
      };
    (r.stdout.on("data", (d) => o.push(d)),
      r.stderr.on("data", (d) => i.push(d)),
      r.on("error", (d) => p(() => n(d))),
      r.on("close", (d) => {
        p(() => {
          if (d === 0) {
            t(Buffer.concat(o).toString("utf8"));
            return;
          }
          let g = Buffer.concat(i).toString("utf8").trim();
          n(new Error(g || `exited with code ${d}`));
        });
      }),
      a > 0 &&
        ((m = setTimeout(() => {
          (r.kill("SIGTERM"),
            r.stdout.destroy(),
            r.stderr.destroy(),
            r.unref(),
            p(() =>
              n(new Error(`resolver timed out after ${a}ms: ${e.command} ${e.args.join(" ")}`)),
            ));
        }, a)),
        m.unref?.()));
  });
}
function _$(e, t) {
  let n;
  try {
    n = JSON.parse(e);
  } catch (o) {
    throw new Error(`invalid JSON from ${t}: ${o.message}`);
  }
  if (!n || typeof n != "object")
    throw new Error(`invalid resolver payload from ${t}: expected object`);
  let r = n;
  if (r.schema_version !== 1)
    throw new Error(`unsupported resolver schema_version from ${t}: ${String(r.schema_version)}`);
  if (r.transport === "unix") {
    if (typeof r.profile_name != "string" || typeof r.socket_path != "string")
      throw new Error(`invalid unix resolver payload from ${t}`);
    return {
      schema_version: 1,
      profile_name: r.profile_name,
      transport: "unix",
      socket_path: r.socket_path,
    };
  }
  if (r.transport === "ssh") {
    if (
      typeof r.profile_name != "string" ||
      typeof r.destination != "string" ||
      typeof r.gateway_command != "string" ||
      typeof r.start_command != "string"
    )
      throw new Error(`invalid ssh resolver payload from ${t}`);
    return {
      schema_version: 1,
      profile_name: r.profile_name,
      transport: "ssh",
      destination: r.destination,
      gateway_command: r.gateway_command,
      start_command: r.start_command,
    };
  }
  throw new Error(`unsupported resolver transport from ${t}: ${String(r.transport)}`);
}
function Qg(e, t) {
  let n = process.env[e];
  if (!n) return t;
  let r = Number(n);
  if (!Number.isFinite(r)) return t;
  let o = Math.floor(r);
  return o > 0 ? o : 0;
}
function ch(e) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(e) ? e : JSON.stringify(e);
}
var j$ = /^[A-Za-z0-9_.:-]+$/;
function L$(e) {
  return e
    ? Object.entries(e)
        .sort(([t], [n]) => t.localeCompare(n))
        .map(([t, n]) => {
          let r = t.trim();
          if (!r) throw new _("INVALID_NEED", "resource need key must be non-empty");
          if (r.startsWith("need."))
            throw new _("INVALID_NEED", `resource need key \`${r}\` must omit the need. prefix`);
          if (!j$.test(r))
            throw new _(
              "INVALID_NEED",
              `resource need key \`${r}\` may contain only letters, numbers, _, ., :, and -`,
            );
          if (typeof n == "number") {
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0)
              throw new _(
                "INVALID_NEED",
                `resource need \`${r}\` must be a non-negative integer count or string quantity`,
              );
            return `need.${r}=${n}`;
          }
          if (typeof n != "string")
            throw new _(
              "INVALID_NEED",
              `resource need \`${r}\` must be a string quantity or non-negative integer count`,
            );
          let o = n.trim();
          if (!o) throw new _("INVALID_NEED", `resource need \`${r}\` must be non-empty`);
          return `need.${r}=${ch(o)}`;
        })
    : [];
}
var N$ = new Set(["Pending", "Running", "Done", "Failed", "Killed", "Cancelled"]),
  D$ = new Set(["User", "ChainAborted", "Timeout"]);
function Ct(e, t) {
  return new Error(`invalid cue-shell IPC message at ${e}: ${t}`);
}
function ja(e, t) {
  if (!e || typeof e != "object" || Array.isArray(e)) throw Ct(t, "expected an object");
  return e;
}
function _a(e, t, n) {
  let r = e[t];
  if (typeof r != "string") throw Ct(`${n}.${t}`, "expected a string");
  return r;
}
function F$(e, t, n, r) {
  let o = e[t];
  if (!Number.isSafeInteger(o) || o < 0 || (r !== void 0 && o > r))
    throw Ct(`${n}.${t}`, "expected a non-negative integer");
  return o;
}
function Zg(e, t, n) {
  let r = new Set(t);
  for (let o of Object.keys(e)) if (!r.has(o)) throw Ct(n, `unknown field ${o}`);
  for (let o of t) if (!(o in e)) throw Ct(n, `missing field ${o}`);
}
function q$(e, t, n) {
  let r = ja(e, n),
    o = Object.keys(r);
  if (o.length !== 1) throw Ct(n, "expected exactly one protocol variant");
  let i = o[0];
  if (!t.has(i)) throw Ct(n, `unknown protocol variant ${i}`);
  return [i, r[i]];
}
function mo(e, t) {
  if (typeof e == "string") {
    if (N$.has(e)) return { status: e };
    throw Ct(t, `unknown job status ${e}`);
  }
  if (!e || typeof e != "object" || Array.isArray(e)) throw Ct(t, "unknown job status");
  let n = e,
    r = Object.keys(n);
  if (
    r.length === 1 &&
    r[0] === "Cancelled" &&
    typeof n.Cancelled == "string" &&
    D$.has(n.Cancelled)
  )
    return { status: "Cancelled", cancelReason: n.Cancelled };
  throw Ct(t, "unknown job status");
}
function U$(e, t) {
  return mo(e, t).status;
}
function K$(e) {
  let t = Dg(e);
  return (J$(t), t);
}
function B$(e) {
  let t = Fg(e);
  return (G$(t), t);
}
function J$(e) {
  "JobInfo" in e
    ? Ra(e.JobInfo, "response.payload.Ok.JobInfo")
    : "JobList" in e
      ? e.JobList.forEach((t, n) => Ra(t, `response.payload.Ok.JobList[${n}]`))
      : "JobListPage" in e
        ? e.JobListPage.jobs.forEach((t, n) => Ra(t, `response.payload.Ok.JobListPage.jobs[${n}]`))
        : "ChainCreated" in e
          ? Da(e.ChainCreated.chain, "response.payload.Ok.ChainCreated.chain")
          : "ScriptCreated" in e
            ? e.ScriptCreated.items.forEach((t, n) =>
                La(t, `response.payload.Ok.ScriptCreated.items[${n}]`),
              )
            : "ScriptInfo" in e &&
              e.ScriptInfo.items.forEach((t, n) =>
                La(t, `response.payload.Ok.ScriptInfo.items[${n}]`),
              );
}
function G$(e) {
  if ("JobStateChanged" in e) {
    let t = e.JobStateChanged,
      n = mo(t.old_state, "event.payload.JobStateChanged.old_state"),
      r = mo(t.new_state, "event.payload.JobStateChanged.new_state");
    ((t.old_state = n.status),
      (t.new_state = r.status),
      r.cancelReason && (t.cancelReason = r.cancelReason));
  } else
    "ChainProgress" in e
      ? Da(e.ChainProgress.chain, "event.payload.ChainProgress.chain")
      : "ScriptItemCreated" in e &&
        La(e.ScriptItemCreated.item, "event.payload.ScriptItemCreated.item");
}
function Ra(e, t) {
  let n = mo(e.status, `${t}.status`);
  ((e.status = n.status), n.cancelReason && (e.cancelReason = n.cancelReason));
}
function Da(e, t) {
  e.jobs.forEach((n, r) => {
    let o = mo(n.status, `${t}.jobs[${r}].status`);
    ((n.status = o.status), o.cancelReason && (n.cancelReason = o.cancelReason));
  });
}
function La(e, t) {
  e.result.kind === "chain" && Da(e.result.chain, `${t}.result.chain`);
}
function z$(e, t, n = !1) {
  if (!e) return t;
  if (
    e.result.kind !== "chain" ||
    t.result.kind !== "chain" ||
    e.result.chain_id !== t.result.chain_id
  )
    return n ? t : e;
  let r = new Map(),
    o = n ? e.result.chain.jobs : t.result.chain.jobs,
    i = n ? t.result.chain.jobs : e.result.chain.jobs;
  for (let g of o) r.set(g.index, g);
  for (let g of i) {
    let x = r.get(g.index);
    r.set(g.index, x ? { ...x, ...g } : g);
  }
  let a = [...new Set([...e.result.job_ids, ...t.result.job_ids])],
    c = n ? e.result.chain : t.result.chain,
    m = n ? t.result.chain : e.result.chain,
    p = n ? e.result : t.result,
    d = n ? t.result : e.result;
  return {
    ...(n ? e : t),
    ...(n ? t : e),
    result: {
      ...p,
      ...d,
      job_ids: a,
      chain: {
        ...c,
        ...m,
        total_jobs: Math.max(t.result.chain.total_jobs, e.result.chain.total_jobs, a.length),
        jobs: [...r.values()].sort((g, x) => g.index - x.index),
      },
    },
  };
}
function H$(e) {
  let t = ja(e, "envelope"),
    n = _a(t, "type", "envelope");
  if (n === "response") {
    Zg(t, ["type", "id", "payload"], "response envelope");
    let r = F$(t, "id", "response envelope", 4294967295),
      [o, i] = q$(t.payload, new Set(["Ok", "Err"]), "response.payload"),
      a =
        o === "Ok"
          ? { Ok: K$(i) }
          : (() => {
              let c = ja(qg(i), "response.payload.Err");
              return {
                Err: {
                  code: _a(c, "code", "response.payload.Err"),
                  message: _a(c, "message", "response.payload.Err"),
                },
              };
            })();
    return { type: n, id: r, payload: a };
  }
  if (n === "event")
    return (Zg(t, ["type", "payload"], "event envelope"), { type: n, payload: B$(t.payload) });
  throw Ct("envelope.type", `unexpected inbound message type ${n}`);
}
function Ji(e) {
  return U$(e, "job.status");
}
function Oa(e) {
  return { ...e, status: Ji(e.status) };
}
function qn(e) {
  let t = e.reason,
    n = new Error(t instanceof Error ? t.message : typeof t == "string" ? t : "Aborted");
  return ((n.name = "AbortError"), t !== void 0 && (n.cause = t), n);
}
function eh(e) {
  if (e?.aborted) throw qn(e);
}
function Pa(e) {
  if ("OutputChunk" in e) {
    let t = e.OutputChunk;
    return { id: t.id, stream: t.stream, bytes: Buffer.from(t.data), encoding: "utf8" };
  }
  if ("OutputChunkBinary" in e) {
    let t = e.OutputChunkBinary;
    return {
      id: t.id,
      stream: t.stream,
      bytes: Buffer.from(t.base64, "base64"),
      encoding: "base64",
    };
  }
  return null;
}
function Aa(e) {
  return e.encoding === "base64" && typeof e.base64 == "string"
    ? Buffer.from(e.base64, "base64")
    : Buffer.from(e.data, "utf8");
}
function uo(e) {
  return R$(e)
    ? { text: e.toString("utf8"), encoding: "utf8" }
    : { text: e.toString("utf8"), encoding: "base64", base64: e.toString("base64") };
}
function Ui(e, t) {
  let n = t === "stdout" ? e.stdoutEncoding : e.stderrEncoding,
    r = t === "stdout" ? e.stdoutBase64 : e.stderrBase64,
    o = t === "stdout" ? e.stdout : e.stderr;
  return n === "base64" && r ? Buffer.from(r, "base64") : Buffer.from(o);
}
function th(e, t) {
  if (e.length === 0) return Buffer.alloc(0);
  if (!t) return Buffer.concat(e);
  let n = [];
  for (let [r, o] of e.entries()) (r > 0 && n.push(Buffer.from(t)), n.push(o));
  return Buffer.concat(n);
}
function nh(e) {
  let t = uo(e.stdout),
    n = uo(e.stderr),
    r = [...e.warnings];
  return (
    t.encoding === "base64" &&
      r.push("stdout contains non-UTF-8 bytes; stdout is a lossy view and stdoutBase64 is exact"),
    n.encoding === "base64" &&
      r.push("stderr contains non-UTF-8 bytes; stderr is a lossy view and stderrBase64 is exact"),
    {
      jobId: e.jobId,
      status: e.status,
      ...(e.cancelReason ? { cancelReason: e.cancelReason } : {}),
      stdout: t.text,
      stderr: n.text,
      stdoutEncoding: t.encoding,
      stderrEncoding: n.encoding,
      ...(t.base64 ? { stdoutBase64: t.base64 } : {}),
      ...(n.base64 ? { stderrBase64: n.base64 } : {}),
      stdoutTruncated: e.stdoutTruncated,
      stderrTruncated: e.stderrTruncated,
      exitCode: e.exitCode,
      timedOut: e.timedOut,
      warnings: r,
    }
  );
}
function rh(e) {
  return !e.sawEofForEveryJob || e.live.length === 0
    ? { bytes: e.buffered, truncated: e.bufferedTruncated }
    : e.bufferedTruncated
      ? { bytes: e.live, truncated: !0 }
      : !e.liveOverflowed && e.live.equals(e.buffered)
        ? { bytes: e.live, truncated: !1 }
        : { bytes: e.buffered, truncated: !1 };
}
function ve(e) {
  if ("Err" in e) throw new _(e.Err.code, e.Err.message);
  return e.Ok;
}
function W$(e) {
  return e.code === "NOT_FOUND" && /no output found/i.test(e.message);
}
function Ki(e) {
  return "TextOutput" in e ? e.TextOutput.text : "EvalText" in e ? e.EvalText.text : null;
}
function Ma(e) {
  if (!("ScopeCreated" in e)) return null;
  let t = e.ScopeCreated;
  return typeof t.hash != "string" || typeof t.summary != "string" ? null : t;
}
var V$ = 16 * 1024 * 1024,
  Fn = 4 * 1024 * 1024,
  Bi = 64 * 1024,
  oh = 2,
  X$ = "session-handshake-required",
  Y$ = [
    X$,
    "script-item-created",
    "cancel-execution",
    "operation-idempotency",
    "script-info-recovery",
  ],
  ih = 1024,
  sh = 3e4,
  Q$ = 100,
  mh = 4294967295,
  Z$ = `spark-cue:process:${process.pid}:${Date.now().toString(36)}:${O$().slice(0, 8)}`;
function co(e, t) {
  if (typeof e != "string" || e.length === 0)
    throw new _("INVALID_OPERATION_KEY", `${t} must be a non-empty string`);
  return e;
}
function Fa(e) {
  let t = JSON.stringify([
    "spark-cue-operation-v1",
    co(e.sessionId, "operation sessionId"),
    co(e.toolCallId, "operation toolCallId"),
    co(e.kind, "operation kind"),
  ]);
  return `spark-cue:v1:${uh("sha256").update(t).digest("base64url")}`;
}
function Yt(e, t) {
  if (e) return { ...e, kind: `${co(e.kind, "operation kind")}/${co(t, "operation step")}` };
}
function eT(e) {
  return e >= mh ? 1 : e + 1;
}
function tT(e) {
  return uh("sha256").update(e).digest("hex").slice(0, 16);
}
function qa(e) {
  let t = e
      .split(/[^a-z0-9]+/iu)
      .filter(Boolean)
      .map((a) => a.toUpperCase()),
    n = t.join(""),
    r = new Set([
      "TOKEN",
      "SECRET",
      "PASSWORD",
      "PASSWD",
      "PASS",
      "CREDENTIAL",
      "CREDENTIALS",
      "AUTH",
      "AUTHORIZATION",
      "OAUTH",
      "COOKIE",
      "DSN",
      "PASSPHRASE",
    ]);
  if (
    t.some((a) => r.has(a)) ||
    n.endsWith("TOKEN") ||
    n.endsWith("SECRET") ||
    n.includes("PASSWORD") ||
    n.endsWith("CREDENTIAL") ||
    n.endsWith("CREDENTIALS") ||
    n.endsWith("COOKIE") ||
    n.includes("APIKEY") ||
    n.includes("ACCESSKEY") ||
    n.includes("PRIVATEKEY")
  )
    return !0;
  let o = ["DATABASE", "REDIS", "MONGO", "MONGODB", "POSTGRES", "POSTGRESQL"].some((a) =>
      n.includes(a),
    ),
    i =
      t.some((a) => a === "URL" || a === "URI" || a === "CONNECTIONSTRING") ||
      n.includes("CONNECTIONSTRING");
  return o && i;
}
function ph(e, t) {
  let n = e ?? process.env,
    r = t ?? process.env.SPARK_CUE_FORWARD_SENSITIVE_ENV === "1",
    o = {};
  for (let [i, a] of Object.entries(n)) (!r && qa(i)) || (typeof a == "string" && (o[i] = a));
  return o;
}
function nT(e) {
  let t = e?.cwd?.trim() || process.cwd();
  return {
    sessionId: e?.sessionId?.trim() || `${Z$}:${tT(t)}`,
    cwd: t,
    env: ph(e?.env, e?.forwardSensitiveEnv),
    forwardSensitiveEnv: e?.forwardSensitiveEnv ?? !1,
    refresh: e?.refresh ?? !1,
  };
}
async function ah(e, t) {
  let n = await rT(e);
  return dh(new Un(n), t);
}
async function rT(e) {
  try {
    return await new Promise((t, n) => {
      let r = M$({ path: e }, () => {
          (r.setTimeout(0), t(r));
        }),
        o = iT("PI_CUE_CONNECT_TIMEOUT_MS", ka);
      (o > 0 &&
        r.setTimeout(o, () => {
          r.destroy(new Error(`connect timed out after ${o}ms`));
        }),
        r.on("error", n));
    });
  } catch (t) {
    throw new _(
      "DAEMON_UNREACHABLE",
      `failed to connect to cue-shell daemon socket ${e}: ${oT(t)}`,
    );
  }
}
function oT(e) {
  return e instanceof Error ? e.message : String(e);
}
function iT(e, t) {
  let n = process.env[e];
  if (!n) return t;
  let r = Number(n);
  if (!Number.isFinite(r)) return t;
  let o = Math.floor(r);
  return o > 0 ? o : 0;
}
async function sT(e, t) {
  let n = Na.spawn(e),
    r = new Un(n);
  try {
    return await dh(r, t);
  } catch (o) {
    throw (r.close(), new _("DAEMON_UNREACHABLE", aT(e, n.stderrSnapshot(), o)));
  }
}
async function dh(e, t) {
  try {
    return (await e.handshake(t), await e.pingForVersion(), e);
  } catch (n) {
    throw (
      e.close(),
      n instanceof _ || n instanceof io
        ? n
        : It(
            "cue-shell daemon accepted the connection but IPC initialization failed; upgrade/restart cued",
            n,
          )
    );
  }
}
function aT(e, t, n) {
  let r = t || (n instanceof Error ? n.message : String(n));
  return [
    `cue profile \`${e.profile_name}\` failed to connect via SSH to ${e.destination}.`,
    `Gateway command: ${e.gateway_command}`,
    `Remote daemon startup is explicit; start it with: ssh ${e.destination} ${JSON.stringify(e.start_command)}`,
    `Detail: ${r}`,
  ].join(`
`);
}
var Na = class e extends A$ {
    #o;
    #r = [];
    #n = 0;
    #s = !1;
    constructor(t) {
      (super(),
        (this.#o = t),
        t.stdout.on("data", (n) => this.emit("data", n)),
        t.stdout.on("error", (n) => this.emit("error", n)),
        t.stdin.on("error", (n) => this.emit("error", n)),
        t.stderr.on("data", (n) => this.#u(n)),
        t.stderr.on("error", (n) => {
          this.#u(Buffer.from(`failed to read ssh stderr: ${n.message}`));
        }),
        t.on("error", (n) => this.emit("error", n)),
        t.on("close", () => this.#c()));
    }
    static spawn(t) {
      return new e(
        P$("ssh", [t.destination, t.gateway_command], { stdio: ["pipe", "pipe", "pipe"] }),
      );
    }
    write(t) {
      return this.#o.stdin.write(t);
    }
    destroy(t) {
      (t && this.emit("error", t), this.#o.kill(), this.#c());
    }
    stderrSnapshot() {
      return Buffer.concat(this.#r, this.#n).toString("utf8").trim();
    }
    #u(t) {
      let n = Buffer.from(t);
      if (n.length > Bi) {
        ((n = n.subarray(n.length - Bi)), (this.#r = [n]), (this.#n = n.length));
        return;
      }
      for (this.#r.push(n), this.#n += n.length; this.#n > Bi;) {
        let r = this.#r[0];
        if (!r) break;
        let o = this.#n - Bi;
        r.length <= o
          ? (this.#r.shift(), (this.#n -= r.length))
          : ((this.#r[0] = r.subarray(o)), (this.#n -= o));
      }
    }
    #c() {
      this.#s || ((this.#s = !0), this.emit("close"));
    }
  },
  Un = class e {
    #o;
    #r = 1;
    #n = new Map();
    #s = new Map();
    #u = [];
    #c = [];
    #a = Buffer.alloc(0);
    #m = !1;
    #p = null;
    #y;
    #b;
    constructor(t) {
      ((this.#o = t),
        (this.#y = new Promise((n) => {
          this.#b = n;
        })),
        t.on("data", (n) => this.#S(n)),
        t.on("error", (n) => this.#R(n)),
        t.on("close", () => {
          ((this.#m = !0), this.#x(new ct("connection closed")), this.#b());
        }));
    }
    static __setNextRequestIdForTests(t, n) {
      if (!Number.isInteger(n) || n < 1 || n > mh)
        throw new Error("test request id must be an unsigned non-zero 32-bit integer");
      t.#r = n;
    }
    static __pendingRequestCountForTests(t) {
      return t.#n.size;
    }
    static async connect(t, n) {
      return t ? ah(t, n) : e.connectResolved(await Dn(), n);
    }
    static async connectResolved(t, n) {
      return t.transport === "unix" ? ah(t.socket_path, n) : sT(t, n);
    }
    get closed() {
      return this.#m ? Promise.resolve() : this.#y;
    }
    get isClosed() {
      return this.#m;
    }
    get daemonInstanceId() {
      return this.#p;
    }
    async #I(t, n = "Job", r) {
      return this.#t({ Eval: { input: t, mode: n } }, r);
    }
    async #i(t, n = "Job", r) {
      let o = await this.#I(t, n, r);
      return this.#e(o);
    }
    async eval(t, n = "Job", r = {}) {
      let o = [];
      (r.pty !== void 0 && o.push(`pty=${r.pty ? "true" : "false"}`),
        r.cwd && o.push(`cwd=${ch(r.cwd)}`),
        o.push(...L$(r.needs)));
      let i = o.length > 0 ? `(${o.join(",")})` : "";
      return this.#t({ Eval: { input: `:run${i} ${t}`, mode: n } }, r.operation);
    }
    async subscribe(t) {
      let n = await this.#t({ Subscribe: { channels: t } });
      await this.#e(n);
    }
    async unsubscribe(t) {
      if (t.length === 0) return;
      let n = await this.#t({ Unsubscribe: { channels: t } });
      await this.#e(n);
    }
    async fgAttach(t) {
      let n = await this.#t({ FgAttach: { id: t } }),
        r = ve(await this.#e(n));
      if ("FgAttached" in r) return r.FgAttached.id;
      throw new _("UNEXPECTED_RESPONSE", "expected FgAttached response");
    }
    async fgDetach() {
      let t = await this.#t({ FgDetach: {} });
      if (!("Ack" in ve(await this.#e(t))))
        throw new _("UNEXPECTED_RESPONSE", "expected Ack response");
    }
    async fgInput(t) {
      let n = Buffer.from(t).toString("base64"),
        r = await this.#t({ FgInput: { data: n } });
      if (!("Ack" in ve(await this.#e(r))))
        throw new _("UNEXPECTED_RESPONSE", "expected Ack response");
    }
    async fgResize(t, n) {
      if (!Number.isInteger(t) || t < 0 || t > 65535 || !Number.isInteger(n) || n < 0 || n > 65535)
        throw new _("INVALID_REQUEST", "foreground PTY size must use unsigned 16-bit values");
      let r = await this.#t({ FgResize: { cols: t, rows: n } });
      if (!("Ack" in ve(await this.#e(r))))
        throw new _("UNEXPECTED_RESPONSE", "expected Ack response");
    }
    async complete(t, n) {
      let r = await this.#t({ Complete: { input: t, cursor: n } }),
        o = ve(await this.#e(r));
      if ("CompletionList" in o) return o.CompletionList.items;
      throw new _("UNEXPECTED_RESPONSE", "expected CompletionList response");
    }
    async highlight(t) {
      let n = await this.#t({ Highlight: { input: t } }),
        r = ve(await this.#e(n));
      if ("HighlightResult" in r) return r.HighlightResult.spans;
      throw new _("UNEXPECTED_RESPONSE", "expected HighlightResult response");
    }
    async handshake(t) {
      let n = nT(t),
        r;
      try {
        let i = await this.#t({
          Handshake: {
            session_id: n.sessionId,
            cwd: n.cwd,
            env: ph(n.env, n.forwardSensitiveEnv),
            refresh: n.refresh,
          },
        });
        r = await this.#e(i);
      } catch (i) {
        throw It(
          "cue-shell daemon did not complete the required session Handshake; upgrade/restart cued",
          i,
        );
      }
      if ("Err" in r)
        throw It(
          `cue-shell daemon rejected the required session Handshake: ${r.Err.code}: ${r.Err.message}; upgrade/restart cued`,
        );
      let o = r.Ok;
      if (!o || !("Ack" in o))
        throw It(
          "cue-shell daemon returned an unexpected response to the required session Handshake; upgrade/restart cued",
        );
    }
    async pingForVersion() {
      let t = await this.#t({ Ping: {} }),
        n = await this.#e(t);
      if ("Err" in n) throw new _(n.Err.code, n.Err.message);
      let r = n.Ok;
      if (!r || !("Pong" in r)) throw It("cue-shell daemon did not return Pong to Ping");
      let o = r.Pong,
        i = o?.version;
      if (typeof i != "string" || i.length === 0)
        throw It("cue-shell daemon Pong is missing version; upgrade/restart cued");
      let a = o.protocol_version;
      if (typeof a != "number" || a < oh)
        throw It(
          `cue-shell daemon IPC protocol version ${String(a)} is older than required ${oh}; upgrade/restart cued`,
        );
      let c = Array.isArray(o.capabilities) ? o.capabilities : [];
      for (let p of Y$)
        if (!c.includes(p))
          throw It(
            `cue-shell daemon is missing required IPC capability ${p}; upgrade/restart cued`,
          );
      if (o.ready === !1) throw new io("cue-shell daemon is still starting; retry the connection");
      let m = o.instance_id;
      if (m !== void 0 && (typeof m != "string" || m.length === 0))
        throw It("cue-shell daemon Pong has an invalid instance_id; upgrade/restart cued");
      if (m !== void 0 && this.#p !== null && this.#p !== m)
        throw It("cue-shell daemon changed instance_id on one connection");
      return ((this.#p = m ?? null), i);
    }
    async ping() {
      await this.pingForVersion();
    }
    async runJob(t, n) {
      let r = (n?.timeout ?? 300) * 1e3,
        o = n?.cwd,
        i = n?.pty ?? !1,
        a = n?.needs,
        c = n?.signal;
      (eh(c), await this.#f("jobs"));
      let m = await this.eval(t, "Job", {
          cwd: o,
          pty: i,
          needs: a,
          operation: Yt(n?.operation, "submit"),
        }),
        p = await this.#e(m);
      if ("Err" in p) throw new _(p.Err.code, p.Err.message);
      let d = p.Ok,
        g = [],
        x = null,
        I = [],
        T,
        $;
      if (d && "ChainCreated" in d) {
        let E = d.ChainCreated;
        ((g = E.job_ids),
          (x = E.job_ids[0] ?? E.chain_id),
          (T = E.chain_id),
          ($ = E.chain.total_jobs),
          (I = E.warnings));
      } else if (d && "JobCreated" in d) {
        let E = d.JobCreated,
          v = E.job_id,
          O = await this.#l(E);
        (O
          ? ((g = O.map((b) => b.id)),
            (x = g[0] ?? v),
            (T = String(O[0]?.chain_id ?? E.chain_id)),
            ($ = O.length))
          : ((g = [v]), (x = v)),
          (I = E.warnings));
      }
      if (!x || g.length === 0) throw new _("UNEXPECTED_RESPONSE", "no job id from response");
      let y = T ?? x,
        h = g.map((E) => `output:${E}`);
      try {
        if (c?.aborted) throw (await this.cancelExecution(y, Yt(n?.operation, "cancel")), qn(c));
        for (let E of h) await this.subscribe([E]);
        return await this.#P(x, g, r, I, T, $, c, n?.operation);
      } finally {
        await this.unsubscribe(h).catch(() => {});
      }
    }
    async startJob(t, n) {
      await this.#f("jobs");
      let r = await this.eval(t, "Job", {
          cwd: n?.cwd,
          pty: n?.pty ?? !1,
          needs: n?.needs,
          operation: Yt(n?.operation, "submit"),
        }),
        o = await this.#e(r);
      if ("Err" in o) throw new _(o.Err.code, o.Err.message);
      let i = o.Ok;
      if (i && "ChainCreated" in i) {
        let a = i.ChainCreated;
        return {
          jobId: a.job_ids[0] ?? a.chain_id,
          kind: "chain",
          chain: a.chain,
          warnings: a.warnings,
        };
      }
      if (i && "JobCreated" in i) {
        let a = i.JobCreated,
          c = await this.#l(a);
        if (c) {
          let m = String(c[0]?.chain_id ?? a.chain_id);
          return {
            jobId: c[0]?.id ?? a.job_id,
            kind: "chain",
            chain: this.#C(m, t, c.length, c),
            warnings: a.warnings,
          };
        }
        return { jobId: a.job_id, kind: "job", pipeline: t, warnings: a.warnings };
      }
      throw new _("UNEXPECTED_RESPONSE", "expected JobCreated or ChainCreated response");
    }
    async runScript(t) {
      let { path: n, input: r } = t,
        o = (t.timeout ?? 300) * 1e3,
        i = t.signal;
      (eh(i), await this.#f("jobs"));
      let a = await this.#t({ RunScript: { path: n, input: r } }, Yt(t.operation, "submit")),
        c = await this.#e(a);
      if ("Err" in c) throw new _(c.Err.code, c.Err.message);
      let m = c.Ok;
      if (!m || !("ScriptCreated" in m))
        throw new _("UNEXPECTED_RESPONSE", "expected ScriptCreated response");
      let p = m.ScriptCreated;
      if (p.submit_error) {
        let L = p.submit_error;
        throw new _(
          L.code,
          `script ${p.script_id} submission failed at item ${L.index}: ${L.message}`,
        );
      }
      if (i?.aborted)
        throw (await this.cancelExecution(p.script_id, Yt(t.operation, "cancel")), qn(i));
      let d = new Map(p.items.map((L) => [L.index, L])),
        g = new Map(),
        x = new Set(),
        I = new Map(),
        T = new Map(),
        $ = new Map(),
        y = new Map(),
        h = new Set(),
        E = new Set(),
        v = !0,
        O = (L) => {
          (I.has(L) || (I.set(L, []), $.set(L, 0)), T.has(L) || (T.set(L, []), y.set(L, 0)));
        },
        b = (L, ie, K, q) => {
          O(K);
          let se = L.get(K);
          if (!se) return;
          let Me = ie.get(K) ?? 0;
          if (Me >= Fn) return;
          let ze = Fn - Me,
            Ne = q.length > ze ? q.slice(0, ze) : q;
          Ne && (se.push(Ne), ie.set(K, Me + Ne.length));
        },
        G = async (L, ie) => {
          let K = g.get(L) ?? [];
          if ((K.includes(ie) || K.push(ie), g.set(L, K), !x.has(ie))) {
            (x.add(ie), O(ie));
            let q = `output:${ie}`;
            if (!v) return;
            (await this.subscribe([q]), v ? E.add(q) : await this.unsubscribe([q]).catch(() => {}));
          }
        };
      for (let L of d.values())
        if (L.result.kind === "job") await G(L.index, L.result.job_id);
        else if (L.result.kind === "chain") for (let ie of L.result.job_ids) await G(L.index, ie);
      if (i?.aborted)
        throw (
          await this.cancelExecution(p.script_id, Yt(t.operation, "cancel")),
          await this.unsubscribe([...E]).catch(() => {}),
          qn(i)
        );
      return new Promise((L, ie) => {
        let K = null,
          q = !1,
          se = !1,
          Me,
          ze = !1,
          Ne,
          bn = !1,
          Ir = Date.now() + o,
          In = [],
          Qt = new Set(),
          Cr = () => {
            ((v = !1), Me && clearInterval(Me), i?.removeEventListener("abort", ou));
            for (let M of In) M();
          },
          Tt = async () => {
            (await this.unsubscribe([...E]).catch(() => {}), E.clear());
          },
          H = async (M) => {
            q || ((q = !0), Ne && clearTimeout(Ne), Cr(), await Tt(), ie(M));
          },
          k = async () => {
            let M = [],
              W = [...d.values()].sort((me, Zt) => me.index - Zt.index);
            for (let me of W) M.push(await this.#$(me, g.get(me.index) ?? [], I, T));
            return M;
          },
          ge = async () => {
            if (!q && !(!K || !se)) {
              ((q = !0),
                Ne && clearTimeout(Ne),
                Cr(),
                await new Promise((M) => setTimeout(M, 50)),
                await Promise.all([...Qt]));
              try {
                let M = await k();
                (await Tt(),
                  L({
                    scriptId: p.script_id,
                    source: p.source ?? { kind: "inline" },
                    status: K.status,
                    exitCode: K.exit_code,
                    failedItemIndex: K.failed_item_index ?? null,
                    items: M,
                    timedOut: !1,
                  }));
              } catch (M) {
                (await Tt(), ie(M));
              }
            }
          },
          ae = () => (q ? !1 : ((q = !0), Ne && clearTimeout(Ne), Cr(), !0)),
          Er = async (M) => {
            if (ae())
              try {
                (await this.cancelExecution(p.script_id, Yt(t.operation, "cancel")),
                  await Tt(),
                  ie(qn(M)));
              } catch (W) {
                (await Tt(), ie(W));
              }
          },
          Ix = async () => {
            if (!ae()) return;
            let M = [];
            try {
              M = await k();
            } catch {
              M = [];
            }
            (await Tt(),
              L({
                scriptId: p.script_id,
                source: p.source ?? { kind: "inline" },
                status: "running",
                exitCode: null,
                failedItemIndex: null,
                items: M,
                timedOut: !0,
              }));
          },
          Cx = () => {
            q ||
              bn ||
              ((bn = !0),
              (Ne = setTimeout(
                () => {
                  Ix();
                },
                Math.max(0, Ir - Date.now()),
              )));
          },
          ou = () => {
            i && Er(i);
          };
        i?.addEventListener("abort", ou, { once: !0 });
        let Ex = (M) => {
            let W = Pa(M);
            if (!W || !x.has(W.id)) return;
            let me = W.bytes.toString("utf8");
            (W.stream === "stdout" ? b(I, $, W.id, me) : b(T, y, W.id, me),
              W.encoding === "base64" &&
                !h.has(W.id) &&
                (h.add(W.id),
                b(
                  T,
                  y,
                  W.id,
                  `[non-UTF-8 process output rendered as a lossy UTF-8 view; OutputChunkBinary.base64 preserves the exact bytes]
`,
                )));
          },
          iu = new Set(),
          rs = (M) => {
            iu.has(M) || (iu.add(M), In.push(this.onEvent(`output:${M}`, Ex)));
          };
        for (let M of x) rs(M);
        let su = async (M, W = !1) => {
            let me = z$(d.get(M.index), M, W);
            d.set(me.index, me);
            let Zt =
              me.result.kind === "job"
                ? [me.result.job_id]
                : me.result.kind === "chain"
                  ? me.result.job_ids
                  : [];
            if (W && me.result.kind === "chain") {
              let mt = me.result.chain_id,
                wr = (await this.listJobs())
                  .filter((Cn) => Cn.chain_id != null && String(Cn.chain_id) === mt)
                  .map((Cn) => Cn.id);
              for (let Cn of wr) Zt.includes(Cn) || Zt.push(Cn);
              me.result.job_ids = Zt;
            }
            for (let mt of Zt) (await G(me.index, mt), rs(mt));
          },
          au = (M) => {
            let W = su(M);
            (Qt.add(W), W.catch((me) => H(me)).finally(() => Qt.delete(W)));
          },
          wo,
          wx = (M) => {
            if ("ScriptItemCreated" in M) {
              let W = M.ScriptItemCreated;
              W.script_id === p.script_id && au(W.item);
              return;
            }
            if ("ScriptFinished" in M) {
              let W = M.ScriptFinished;
              W.script_id === p.script_id &&
                ((K = {
                  status: W.status,
                  exit_code: W.exit_code,
                  failed_item_index: W.failed_item_index,
                }),
                wo());
              return;
            }
            if ("ChainProgress" in M) {
              let W = M.ChainProgress,
                me = [...d.values()].find(
                  (mt) => mt.result.kind === "chain" && mt.result.chain_id === W.chain.id,
                );
              if (!me || me.result.kind !== "chain") return;
              let Zt = W.chain.jobs.flatMap((mt) => (mt.job_id ? [mt.job_id] : []));
              ((me.result.chain = W.chain),
                (me.result.job_ids = [...new Set([...me.result.job_ids, ...Zt])]));
              for (let mt of W.chain.jobs) {
                let wr = mt.job_id;
                wr && G(me.index, wr).then(() => rs(wr));
              }
            }
          };
        In.push(this.onEvent("jobs", wx));
        for (let M of this.#u) M.script_id === p.script_id && au(M.item);
        let $o = this.#c.find((M) => M.script_id === p.script_id);
        ($o &&
          (K = {
            status: $o.status,
            exit_code: $o.exit_code,
            failed_item_index: $o.failed_item_index,
          }),
          (wo = async () => {
            if (!(q || ze)) {
              ze = !0;
              try {
                let M = await this.scriptInfo(p.script_id);
                if (q) return;
                for (let W of M.items) await su(W, !0);
                if (M.submit_error) {
                  let W = M.submit_error;
                  await H(
                    new _(
                      W.code,
                      `script ${M.script_id} submission failed at item ${W.index}: ${W.message}`,
                    ),
                  );
                  return;
                }
                M.status !== "running"
                  ? ((se = !0),
                    (K = {
                      status: M.status,
                      exit_code: M.exit_code,
                      failed_item_index: M.failed_item_index,
                    }),
                    await ge())
                  : Cx();
              } catch (M) {
                await H(M);
              } finally {
                ze = !1;
              }
            }
          }),
          q ||
            ((Me = setInterval(() => {
              wo();
            }, 100)),
            Me.unref?.(),
            wo(),
            this.closed.then(() =>
              H(new ct(`connection closed while waiting for script ${p.script_id}`)),
            )));
      });
    }
    async #$(t, n, r, o) {
      let i = [],
        a = [],
        c = "Done",
        m = null,
        p = [];
      for (let g of n) {
        let x = await this.jobStatus(g);
        x &&
          (p.push(x),
          x.status !== "Done" && c === "Done" && (c = x.status),
          x.exit_code != null && (m === null || x.exit_code !== 0) && (m = x.exit_code));
        try {
          let I = await this.jobOutput(g);
          (i.push(I.stdout),
            a.push(I.stderr),
            (I.stdoutEncoding === "base64" || I.stderrEncoding === "base64") &&
              a.push(`[non-UTF-8 process output rendered as a lossy UTF-8 view; use typed jobOutput base64 fields for exact bytes]
`));
        } catch (I) {
          (console.debug(
            `[spark-cue] jobOutput unavailable while summarizing script item ${t.index}; using streamed buffers`,
            I,
          ),
            i.push((r.get(g) ?? []).join("")),
            a.push((o.get(g) ?? []).join("")));
        }
      }
      let d = t.result.kind === "message" ? t.result.text : void 0;
      return {
        index: t.index,
        source: t.source,
        kind: t.result.kind,
        jobIds: n,
        chainId: t.result.kind === "chain" ? t.result.chain_id : null,
        cronId: t.result.kind === "cron" ? t.result.cron_id : null,
        message: d,
        stdout: i.join(""),
        stderr: a.join(""),
        status: c,
        exitCode: m,
        jobs: p,
      };
    }
    async scriptInfo(t) {
      let n = await this.#t({ ScriptInfo: { id: t } }),
        r = ve(await this.#e(n));
      if ("ScriptInfo" in r) return r.ScriptInfo;
      throw new _("UNEXPECTED_RESPONSE", "expected ScriptInfo response");
    }
    async stopJob(t, n) {
      let r = /^C\d+$/u.test(t)
          ? { RemoveCron: { id: t } }
          : /^CH\d+$/u.test(t)
            ? { CancelExecution: { id: t } }
            : { KillJob: { id: t } },
        o = await this.#t(r, n);
      ve(await this.#e(o));
    }
    async cancelExecution(t, n) {
      let r = await this.#t({ CancelExecution: { id: t } }, n);
      ve(await this.#e(r));
    }
    async listJobs(t) {
      let n = await this.#t({ ListJobs: { limit: t ?? null } }),
        r = ve(await this.#e(n));
      if ("JobListPage" in r) return r.JobListPage.jobs.map(Oa);
      if ("JobList" in r) return r.JobList.map(Oa);
      if ("JobInfo" in r) {
        let o = r.JobInfo;
        return [Oa(o)];
      }
      throw new _("UNEXPECTED_RESPONSE", "expected JobListPage, JobList, or JobInfo response");
    }
    async jobStatus(t) {
      return (await this.listJobs()).find((r) => r.id === t) ?? null;
    }
    async #l(t) {
      let n = t.chain_id,
        r = t.chain_total;
      if (!n || !r || r <= 1) {
        let o = await this.jobStatus(t.job_id);
        o?.chain_id != null &&
          o.chain_total &&
          o.chain_total > 1 &&
          ((n = String(o.chain_id)), (r = o.chain_total));
      }
      return !n || !r || r <= 1 ? null : this.#T(n, r);
    }
    #C(t, n, r, o) {
      return {
        id: t,
        pipeline: n,
        total_jobs: r,
        jobs: o.map((i, a) => ({
          index: i.chain_index ?? a,
          pipeline: i.pipeline,
          status: i.status,
          job_id: i.id,
          start_scope: i.start_scope,
          end_scope: i.end_scope,
          open_hint: i.open_hint,
          ...(i.cancelReason ? { cancelReason: i.cancelReason } : {}),
        })),
      };
    }
    async #T(t, n) {
      let r = Date.now() + 1e3;
      for (;;) {
        let o = (await this.listJobs())
          .filter((i) => i.chain_id != null && String(i.chain_id) === t)
          .sort((i, a) => (i.chain_index ?? 0) - (a.chain_index ?? 0));
        if (o.length >= n) return o.slice(0, n);
        if (Date.now() >= r)
          throw new _(
            "UNEXPECTED_RESPONSE",
            `chain ${t} reported ${n} jobs but only ${o.length} were visible`,
          );
        await new Promise((i) => setTimeout(i, 25));
      }
    }
    async cronStatus(t) {
      return (await this.listCrons()).find((r) => r.id === t) ?? null;
    }
    async jobOutput(t, n) {
      let r = await this.#E(t, n ?? null, n ?? null);
      if (!r)
        return {
          stdout: "",
          stderr: "",
          stdoutEncoding: "utf8",
          stderrEncoding: "utf8",
          truncated: !1,
          stderrTruncated: !1,
        };
      let o = uo(Aa(r.stdout)),
        i = uo(Aa(r.stderr));
      return {
        stdout: o.text,
        stderr: i.text,
        stdoutEncoding: o.encoding,
        stderrEncoding: i.encoding,
        ...(o.base64 ? { stdoutBase64: o.base64 } : {}),
        ...(i.base64 ? { stderrBase64: i.base64 } : {}),
        truncated: r.stdout.truncated,
        stderrTruncated: r.stderr.truncated,
      };
    }
    async jobError(t, n) {
      let r = await this.#E(t, null, n ?? null);
      if (!r) return { stderr: "", encoding: "utf8", truncated: !1 };
      let o = uo(Aa(r.stderr));
      return {
        stderr: o.text,
        encoding: o.encoding,
        ...(o.base64 ? { base64: o.base64 } : {}),
        truncated: r.stderr.truncated,
      };
    }
    async #E(t, n, r) {
      try {
        let o = await this.#t({ JobOutput: { id: t, stdout_bytes: n, stderr_bytes: r } }),
          i = ve(await this.#e(o));
        if ("JobOutput" in i) return i.JobOutput;
        throw new _("UNEXPECTED_RESPONSE", "expected JobOutput response");
      } catch (o) {
        if (o instanceof _ && W$(o)) return null;
        throw o;
      }
    }
    async sendInput(t, n, r) {
      let o = await this.#i(`:send ${t} ${n}`, "Job", r);
      if ("Err" in o) throw new _(o.Err.code, o.Err.message);
    }
    async cancelJob(t, n) {
      let r = await this.#i(`:cancel ${t}`, "Job", n);
      if ("Err" in r) throw new _(r.Err.code, r.Err.message);
    }
    async pauseCron(t, n) {
      let r = await this.#i(`:pause ${t}`, "Job", n);
      if ("Err" in r) throw new _(r.Err.code, r.Err.message);
    }
    async resumeCron(t, n) {
      let r = await this.#i(`:resume ${t}`, "Job", n);
      if ("Err" in r) throw new _(r.Err.code, r.Err.message);
    }
    async retryJob(t, n) {
      let r = await this.#i(`:retry ${t}`, "Job", n);
      if ("Err" in r) throw new _(r.Err.code, r.Err.message);
      let o = r.Ok;
      if (o && "ChainCreated" in o) {
        let i = o.ChainCreated;
        return {
          jobId: i.job_ids[0] ?? i.chain_id,
          kind: "chain",
          chain: i.chain,
          warnings: i.warnings,
        };
      }
      if (o && "JobCreated" in o) {
        let i = o.JobCreated,
          a = await this.#l(i);
        if (a) {
          let c = String(a[0]?.chain_id ?? i.chain_id);
          return {
            jobId: a[0]?.id ?? i.job_id,
            kind: "chain",
            chain: this.#C(c, `:retry ${t}`, a.length, a),
            warnings: i.warnings,
          };
        }
        return { jobId: i.job_id, kind: "job", warnings: i.warnings };
      }
      throw new _("UNEXPECTED_RESPONSE", "expected JobCreated or ChainCreated response");
    }
    async evalText(t, n = "Job") {
      let r = await this.#i(t, n),
        o = ve(r),
        i = Ki(o);
      if (i !== null) return i;
      throw new _("UNEXPECTED_RESPONSE", "expected EvalText response");
    }
    async setEnv(t, n) {
      let r = Object.entries(t).map(([c, m]) => `${c}=${m}`),
        o = await this.#i(`:env set ${r.join(" ")}`, "Job", n),
        i = ve(o),
        a = Ma(i);
      if (a) return a;
      throw new _("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
    }
    async unsetEnv(t, n) {
      let r = await this.#i(`:env unset ${t.join(" ")}`, "Job", n),
        o = ve(r),
        i = Ma(o);
      if (i) return i;
      throw new _("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
    }
    async changeDirectory(t, n) {
      let r = await this.#i(`:cd ${t}`, "Job", n),
        o = ve(r),
        i = Ma(o);
      if (i) return i;
      throw new _("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
    }
    async listScopes(t) {
      let n = await this.#t({ ListScopes: { limit: t ?? null } }),
        r = ve(await this.#e(n));
      if ("ScopeListPage" in r) return r.ScopeListPage.scopes;
      if ("ScopeList" in r) return r.ScopeList;
      if ("ScopeInfo" in r) return [r.ScopeInfo];
      throw new _(
        "UNEXPECTED_RESPONSE",
        "expected ScopeListPage, ScopeList, or ScopeInfo response",
      );
    }
    async showEnv() {
      let t = await this.#t({ ShowEnv: { tail_bytes: null } }),
        n = Ki(ve(await this.#e(t)));
      if (n !== null) return n;
      throw new _("UNEXPECTED_RESPONSE", "expected TextOutput or EvalText response");
    }
    async showConfig() {
      let t = await this.#t({ ShowConfig: { tail_bytes: null } }),
        n = Ki(ve(await this.#e(t)));
      if (n !== null) return n;
      throw new _("UNEXPECTED_RESPONSE", "expected TextOutput or EvalText response");
    }
    async showLog(t, n, r) {
      let o = await this.#t({
          ShowLog: { id: t ?? null, limit: n ?? null, tail_bytes: r ?? null },
        }),
        i = Ki(ve(await this.#e(o)));
      if (i !== null) return i;
      throw new _("UNEXPECTED_RESPONSE", "expected TextOutput or EvalText response");
    }
    async addCron(t, n, r) {
      let o = `:cron ${t} ${n}`,
        i = await this.#I(o, "Job", r),
        a = await this.#e(i);
      if ("Err" in a) throw new _(a.Err.code, a.Err.message);
      let c = a.Ok;
      if (c && "CronAdded" in c) return c.CronAdded.cron_id;
      throw new _("UNEXPECTED_RESPONSE", "expected CronAdded response");
    }
    async listCrons(t) {
      let n = await this.#t({ ListCrons: { limit: t ?? null } }),
        r = ve(await this.#e(n));
      if ("CronListPage" in r) return r.CronListPage.crons;
      if ("CronList" in r) return r.CronList;
      throw new _("UNEXPECTED_RESPONSE", "expected CronListPage or CronList response");
    }
    async removeCron(t, n) {
      let r = await this.#t({ RemoveCron: { id: t } }, n);
      ve(await this.#e(r));
    }
    async shutdown(t) {
      let n = await this.#t({ Shutdown: {} }, t);
      ve(await this.#e(n));
    }
    onEvent(t, n) {
      let r = this.#s.get(t);
      return (
        r || ((r = new Set()), this.#s.set(t, r)),
        r.add(n),
        () => {
          (r?.delete(n), r?.size === 0 && this.#s.delete(t));
        }
      );
    }
    close() {
      this.#m || this.#o.destroy();
    }
    #w = new Set();
    async #f(t) {
      this.#w.has(t) || (await this.subscribe([t]), this.#w.add(t));
    }
    #t(t, n) {
      if (this.#m) throw new ct("connection closed");
      if (this.#n.size >= ih)
        throw new _("CLIENT_REQUEST_LIMIT", `refusing to exceed ${ih} pending cue-shell requests`);
      let r = this.#v(),
        o,
        i,
        a = new Promise((d, g) => {
          ((o = d), (i = g));
        });
      a.catch(() => {});
      let c = {
        promise: a,
        resolve: o,
        reject: i,
        claimed: !1,
        settled: !1,
        timer: setTimeout(() => {
          this.#n.get(r) === c &&
            (c.settled ||
              ((c.settled = !0), c.reject(new ct(`request ${r} timed out after ${sh}ms`))),
            this.#g(r, c));
        }, sh),
      };
      this.#n.set(r, c);
      let m = { type: "request", id: r, ...(n ? { operation_id: Fa(n) } : {}), payload: t },
        p = this.#O(m);
      try {
        this.#o.write(p);
      } catch (d) {
        (clearTimeout(c.timer), this.#n.delete(r), (c.settled = !0));
        let g = fa(d, "request write failed");
        throw (c.reject(g), g);
      }
      return Promise.resolve(r);
    }
    #v() {
      for (let t = 0; t <= this.#n.size; t += 1) {
        let n = this.#r;
        if (((this.#r = eT(n)), !this.#n.has(n))) return n;
      }
      throw new _("CLIENT_REQUEST_LIMIT", "no free cue-shell request id is available");
    }
    #g(t, n) {
      if ((clearTimeout(n.timer), n.claimed)) {
        this.#n.delete(t);
        return;
      }
      ((n.timer = setTimeout(() => {
        this.#n.get(t) === n && !n.claimed && this.#n.delete(t);
      }, Q$)),
        n.timer.unref?.());
    }
    #e(t) {
      let n = this.#n.get(t);
      return n
        ? ((n.claimed = !0),
          n.promise.finally(() => {
            this.#n.get(t) === n && (clearTimeout(n.timer), this.#n.delete(t));
          }))
        : Promise.reject(new Error(`unknown or expired request ${t}`));
    }
    #S(t) {
      for (this.#a = Buffer.concat([this.#a, t]); this.#a.length >= 4;) {
        let n = this.#a.readUInt32BE(0);
        if (n > V$) {
          this.#h(new Error(`message too large: ${n} bytes`));
          return;
        }
        if (this.#a.length < 4 + n) break;
        let r = this.#a.subarray(4, 4 + n);
        this.#a = this.#a.subarray(4 + n);
        try {
          let o = H$(JSON.parse(r.toString("utf-8")));
          this.#k(o);
        } catch (o) {
          this.#h(new Error(`failed to parse message: ${o.message}`));
          return;
        }
      }
    }
    #k(t) {
      if (t.type === "response") {
        let n = this.#n.get(t.id);
        if (!n) {
          this.#h(new Error(`response for unknown or expired request ${t.id}`));
          return;
        }
        if (n.settled) return;
        ((n.settled = !0), n.resolve(t.payload), this.#g(t.id, n));
      } else this.#_(t.payload);
    }
    #_(t) {
      let n = null;
      if ("JobStateChanged" in t) n = "jobs";
      else if ("JobCreated" in t) n = "jobs";
      else if ("ChainProgress" in t) n = "jobs";
      else if ("ScriptItemCreated" in t) {
        let r = t.ScriptItemCreated;
        (this.#u.push(r), this.#u.length > 128 && this.#u.shift(), (n = "jobs"));
      } else if ("ScriptFinished" in t) {
        let r = t.ScriptFinished;
        (this.#c.push(r), this.#c.length > 32 && this.#c.shift(), (n = "jobs"));
      } else if ("JobRemoved" in t) n = "jobs";
      else if ("CronTriggered" in t || "CronRemoved" in t) n = "crons";
      else if ("FgOutput" in t || "FgExited" in t) n = "fg";
      else if ("ShuttingDown" in t) n = "system";
      else {
        let r = Pa(t);
        r ? (n = `output:${r.id}`) : "OutputEof" in t && (n = `output:${t.OutputEof.id}`);
      }
      if (n) {
        let r = (o) => {
          if (o)
            for (let i of o)
              try {
                i(t);
              } catch (a) {
                console.debug(`[spark-cue] event listener for ${n} threw`, a);
              }
        };
        (r(this.#s.get(n)), n.startsWith("output:") && r(this.#s.get("output:")));
      }
    }
    #R(t) {
      this.#m || (this.#x(fa(t)), this.#o.destroy());
    }
    #h(t) {
      this.#m || (this.#x(new ct(`protocol failure: ${t.message}`)), this.#o.destroy());
    }
    #x(t) {
      for (let [n, r] of this.#n) (r.settled || ((r.settled = !0), r.reject(t)), this.#g(n, r));
    }
    #O(t) {
      let n = Buffer.from(JSON.stringify(t), "utf-8"),
        r = Buffer.alloc(4);
      return (r.writeUInt32BE(n.length, 0), Buffer.concat([r, n]));
    }
    async #d(t, n, r = []) {
      let o = [],
        i = [],
        a = "Done",
        c,
        m = null,
        p = !1,
        d = !1,
        g = 0,
        x = 0;
      for (let I of n) {
        let T = await this.jobStatus(I);
        T &&
          (T.status !== "Done" && (a = T.status),
          T.cancelReason && (c = T.cancelReason),
          T.exit_code != null && (m === null || T.exit_code !== 0) && (m = T.exit_code));
        let $ = await this.jobOutput(I, Fn),
          y =
            n.length > 1 && $.stdoutEncoding === "utf8"
              ? Buffer.from($.stdout.trimEnd())
              : Ui($, "stdout"),
          h =
            n.length > 1 && $.stderrEncoding === "utf8"
              ? Buffer.from($.stderr.trimEnd())
              : Ui($, "stderr"),
          E = Fn - g,
          v = Fn - x;
        if (y.length > 0 && E > 0) {
          let O = y.subarray(0, E);
          (o.push(O), (g += O.length));
        }
        if (h.length > 0 && v > 0) {
          let O = h.subarray(0, v);
          (i.push(O), (x += O.length));
        }
        ((p ||= $.truncated || y.length > E), (d ||= $.stderrTruncated || h.length > v));
      }
      return nh({
        jobId: t,
        status: a,
        ...(c ? { cancelReason: c } : {}),
        stdout: th(
          o,
          n.length === 1
            ? ""
            : `
`,
        ),
        stderr: th(
          i,
          n.length === 1
            ? ""
            : `
`,
        ),
        stdoutTruncated: p,
        stderrTruncated: d,
        exitCode: m,
        timedOut: !1,
        warnings: r,
      });
    }
    async #P(t, n, r, o = [], i, a = n.length, c, m) {
      let p = a,
        d = p > n.length;
      if (!d && n.length === 1) {
        let I = n[0],
          T = await this.jobStatus(I);
        if (T && ["Done", "Failed", "Killed", "Cancelled"].includes(T.status))
          return this.#d(I, [I], o);
      } else if (!d) {
        let I = !0;
        for (let T of n) {
          let $ = await this.jobStatus(T);
          if (!$ || !["Done", "Failed", "Killed", "Cancelled"].includes($.status)) {
            I = !1;
            break;
          }
        }
        if (I) return this.#d(t, n, o);
      }
      let g = p > 1,
        x = i ?? t;
      if (c?.aborted) throw (await this.cancelExecution(x, Yt(m, "cancel")), qn(c));
      return new Promise((I, T) => {
        let $ = [],
          y = [],
          h = 0,
          E = 0,
          v = !1,
          O = !1,
          b = !1,
          G,
          L = ["Done", "Failed", "Killed", "Cancelled"],
          ie = () => (b ? !1 : ((b = !0), clearTimeout(se), G && clearInterval(G), Tt(), !0)),
          K = async (H) => {
            if (ie())
              try {
                (await this.cancelExecution(x, Yt(m, "cancel")), T(qn(H)));
              } catch (k) {
                T(k);
              }
          },
          q = async () => {
            if (ie())
              try {
                let H = await this.#d(t, n, o);
                I({ ...H, timedOut: !0 });
              } catch (H) {
                T(H);
              }
          },
          se = setTimeout(() => {
            q();
          }, r),
          Me = () => {
            c && K(c);
          };
        c?.addEventListener("abort", Me, { once: !0 });
        let ze = [],
          Ne = (H) => {
            if ("OutputEof" in H) {
              let ge = H.OutputEof;
              n.includes(ge.id) && In.add(ge.id);
              return;
            }
            let k = Pa(H);
            if (k)
              if (k.stream === "stdout") {
                let ge = Fn - h;
                if (ge <= 0) {
                  v = !0;
                  return;
                }
                let ae = k.bytes.subarray(0, ge);
                ($.push(ae), (h += ae.length), (v ||= ae.length < k.bytes.length));
              } else {
                let ge = Fn - E;
                if (ge <= 0) {
                  O = !0;
                  return;
                }
                let ae = k.bytes.subarray(0, ge);
                (y.push(ae), (E += ae.length), (O ||= ae.length < k.bytes.length));
              }
          };
        for (let H of n) ze.push(this.onEvent(`output:${H}`, Ne));
        let bn = (H) => {
            n.includes(H) || (n.push(H), ze.push(this.onEvent(`output:${H}`, Ne)));
          },
          Ir = new Set(),
          In = new Set(),
          Qt = async () => {
            if (b) return;
            let H = n.slice(0, p);
            if (!(H.length < p)) {
              for (let k of H) if (!Ir.has(k)) return;
              (n.splice(0, n.length, ...H),
                (b = !0),
                clearTimeout(se),
                G && clearInterval(G),
                await new Promise((k) => setTimeout(k, 50)),
                Tt());
              try {
                let k = await this.#d(t, n, o),
                  ge = rh({
                    live: Buffer.concat($),
                    liveOverflowed: v,
                    sawEofForEveryJob: H.every((Er) => In.has(Er)),
                    buffered: Ui(
                      {
                        stdout: k.stdout,
                        stderr: k.stderr,
                        stdoutEncoding: k.stdoutEncoding,
                        stderrEncoding: k.stderrEncoding,
                        ...(k.stdoutBase64 ? { stdoutBase64: k.stdoutBase64 } : {}),
                        ...(k.stderrBase64 ? { stderrBase64: k.stderrBase64 } : {}),
                        truncated: k.stdoutTruncated,
                        stderrTruncated: k.stderrTruncated,
                      },
                      "stdout",
                    ),
                    bufferedTruncated: k.stdoutTruncated,
                  }),
                  ae = rh({
                    live: Buffer.concat(y),
                    liveOverflowed: O,
                    sawEofForEveryJob: H.every((Er) => In.has(Er)),
                    buffered: Ui(
                      {
                        stdout: k.stdout,
                        stderr: k.stderr,
                        stdoutEncoding: k.stdoutEncoding,
                        stderrEncoding: k.stderrEncoding,
                        ...(k.stdoutBase64 ? { stdoutBase64: k.stdoutBase64 } : {}),
                        ...(k.stderrBase64 ? { stderrBase64: k.stderrBase64 } : {}),
                        truncated: k.stdoutTruncated,
                        stderrTruncated: k.stderrTruncated,
                      },
                      "stderr",
                    ),
                    bufferedTruncated: k.stderrTruncated,
                  });
                I(
                  nh({
                    jobId: k.jobId,
                    status: k.status,
                    ...(k.cancelReason ? { cancelReason: k.cancelReason } : {}),
                    stdout: ge.bytes,
                    stderr: ae.bytes,
                    stdoutTruncated: ge.truncated,
                    stderrTruncated: ae.truncated,
                    exitCode: k.exitCode,
                    timedOut: !1,
                    warnings: k.warnings,
                  }),
                );
              } catch (k) {
                T(k);
              }
            }
          },
          Cr = this.onEvent("jobs", (H) => {
            if ("JobCreated" in H && i) {
              let k = H.JobCreated;
              k.chain_id === i && bn(k.job_id);
            }
            if ("ChainProgress" in H && i) {
              let k = H.ChainProgress;
              if (k.chain.id === i) {
                for (let ae of k.chain.jobs) ae.job_id && bn(ae.job_id);
                let ge = k.chain.jobs.filter((ae) => L.includes(Ji(ae.status)));
                ge.some((ae) => Ji(ae.status) !== "Done")
                  ? ((p = ge.filter((ae) => ae.job_id).length), Qt())
                  : ge.length === k.chain.jobs.length &&
                    ((p = k.chain.jobs.filter((ae) => ae.job_id).length), Qt());
              }
            }
            if ("JobStateChanged" in H) {
              let k = H.JobStateChanged;
              if ((!g && k.job_id !== t) || (g && k.chain_id !== i && !n.includes(k.job_id)))
                return;
              g && k.chain_id === i && bn(k.job_id);
              let ge = Ji(k.new_state);
              L.includes(ge) && (Ir.add(k.job_id), Qt());
            }
          });
        G = setInterval(() => {
          b ||
            (async () => {
              try {
                let H = g && i ? await this.listJobs() : [];
                if (g && i)
                  for (let k of H) k.chain_id != null && String(k.chain_id) === i && bn(k.id);
                for (let k of n) {
                  let ge = H.find((ae) => ae.id === k) ?? (await this.jobStatus(k));
                  if (ge && L.includes(ge.status) && (Ir.add(k), g && ge.status !== "Done")) {
                    let ae = typeof ge.chain_index == "number" ? ge.chain_index : void 0;
                    p = Math.min(p, ae === void 0 ? n.indexOf(k) + 1 : ae + 1);
                  }
                }
                await Qt();
              } catch (H) {
                if (b) return;
                ((b = !0), clearTimeout(se), G && clearInterval(G), Tt(), T(H));
              }
            })();
        }, 100);
        function Tt() {
          (c?.removeEventListener("abort", Me), Cr());
          for (let H of ze) H();
        }
      });
    }
  };
var lh = [
    161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208,
    208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252,
    254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319,
    322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466,
    468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713,
    715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961,
    963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221,
    8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308,
    8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470,
    8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585,
    8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712,
    8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741,
    8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801,
    8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869,
    8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633,
    9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681,
    9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792,
    9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919,
    9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977,
    9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743,
    65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373,
    127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109,
  ],
  fh = 12288,
  gh = 65510,
  hh = [12288, 12288, 65281, 65376, 65504, 65510];
var xh = 4352,
  yh = 262141,
  Ua = [
    4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749,
    9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918,
    9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981,
    9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071,
    10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904,
    11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543,
    12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128,
    42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126,
    65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576,
    110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933,
    110933, 110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183,
    127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568,
    127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904,
    127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066,
    128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420,
    128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732,
    128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340,
    129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741,
    129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141,
  ];
var Gi = (e, t) => {
  let n = 0,
    r = Math.floor(e.length / 2) - 1;
  for (; n <= r;) {
    let o = Math.floor((n + r) / 2),
      i = o * 2;
    if (t < e[i]) r = o - 1;
    else if (t > e[i + 1]) n = o + 1;
    else return !0;
  }
  return !1;
};
var bh = 19968,
  [mT, pT] = dT(Ua);
function dT(e) {
  let t = e[0],
    n = e[1];
  for (let r = 0; r < e.length; r += 2) {
    let o = e[r],
      i = e[r + 1];
    if (bh >= o && bh <= i) return [o, i];
    i - o > n - t && ((t = o), (n = i));
  }
  return [t, n];
}
var Ih = (e) => (e < 161 || e > 1114109 ? !1 : Gi(lh, e)),
  Ch = (e) => (e < fh || e > gh ? !1 : Gi(hh, e));
var Eh = (e) => (e >= mT && e <= pT ? !0 : e < xh || e > yh ? !1 : Gi(Ua, e));
function lT(e) {
  if (!Number.isSafeInteger(e)) throw new TypeError(`Expected a code point, got \`${typeof e}\`.`);
}
function Ka(e, { ambiguousAsWide: t = !1 } = {}) {
  return (lT(e), Ch(e) || Eh(e) || (t && Ih(e)) ? 2 : 1);
}
var lo = new Intl.Segmenter(void 0, { granularity: "grapheme" }),
  fT = new RegExp(
    "^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$",
    "v",
  ),
  gT = new RegExp(
    "^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+",
    "v",
  ),
  hT = new RegExp(
    "^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})$",
    "v",
  ),
  xT = new RegExp("^\\p{Mark}$", "v"),
  wh = new RegExp(
    "^(?:[\\p{Spacing_Mark}--[\\u1734\\u302E\\u302F]]|[\\u065F\\u0F7F\\u102B\\u102C\\u1031\\u1033-\\u1035\\u1038\\u103A-\\u103E])+$",
    "v",
  ),
  yT = new RegExp("^\\p{RGI_Emoji}$", "v");
var bT = 512,
  po = new Map();
function IT(e) {
  let t = e.codePointAt(0);
  return t === void 0
    ? !1
    : (t >= 126976 && t <= 130047) ||
        (t >= 8960 && t <= 9215) ||
        (t >= 9728 && t <= 10175) ||
        (t >= 11088 && t <= 11093) ||
        e.includes("\uFE0F") ||
        e.length > 2;
}
function Ga(e) {
  for (let t = 0; t < e.length; t += 1) {
    let n = e.charCodeAt(t);
    if (n < 32 || n > 126) return !1;
  }
  return !0;
}
function $h(e) {
  let t = [];
  for (let n of e) t.push(n);
  return t;
}
function fr(e, t) {
  if (t >= e.length || e[t] !== "\x1B") return null;
  let n = e[t + 1];
  if (n === "[") {
    let r = t + 2;
    for (; r < e.length && !/[mGKHJ]/.test(e[r] ?? "");) r += 1;
    return r < e.length ? { code: e.slice(t, r + 1), length: r + 1 - t } : null;
  }
  if (n === "]" || n === "_") {
    let r = t + 2;
    for (; r < e.length;) {
      if (e[r] === "\x07") return { code: e.slice(t, r + 1), length: r + 1 - t };
      if (e[r] === "\x1B" && e[r + 1] === "\\")
        return { code: e.slice(t, r + 2), length: r + 2 - t };
      r += 1;
    }
    return null;
  }
  return null;
}
function CT(e) {
  if (!e.startsWith("\x1B]8;")) return;
  let t = e.endsWith("\x07") ? "\x07" : "\x1B\\",
    n = e.slice(4, t === "\x07" ? -1 : -2),
    r = n.indexOf(";");
  if (r === -1) return;
  let o = n.slice(0, r),
    i = n.slice(r + 1);
  return i ? { params: o, url: i, terminator: t } : null;
}
function ET(e) {
  return `\x1B]8;;${e}`;
}
function wT(e) {
  if (!e.includes("\x1B]8;")) return "";
  let t = null,
    n = 0;
  for (; n < e.length;) {
    let r = fr(e, n);
    if (r) {
      let o = CT(r.code);
      (o !== void 0 && (t = o), (n += r.length));
    } else n += 1;
  }
  return t ? ET(t.terminator) : "";
}
function fo(e) {
  if (e === "	") return 3;
  if (wh.test(e)) return $h(e).length;
  if (fT.test(e)) return 0;
  if (IT(e) && yT.test(e)) return 2;
  let t = e.replace(gT, ""),
    n = t.codePointAt(0);
  if (n === void 0) return 0;
  if (n >= 127462 && n <= 127487) return 2;
  let r = Ka(n),
    o = !1,
    i = $h(t);
  for (let a of i.slice(1))
    if (wh.test(a)) ((r += 1), (o = !1));
    else if (xT.test(a)) o = !0;
    else if (!hT.test(a)) {
      let c = a.codePointAt(0);
      if (c === void 0) continue;
      (o || (c >= 65280 && c <= 65519) ? (r += Ka(c)) : (c === 3635 || c === 3763) && (r += 1),
        (o = !1));
    }
  return r;
}
function $T(e, t) {
  if (t <= 0 || e.length === 0) return { text: "", width: 0 };
  if (Ga(e)) {
    let m = e.slice(0, t);
    return { text: m, width: m.length };
  }
  let n = e.includes("\x1B"),
    r = e.includes("	");
  if (!n && !r) {
    let m = "",
      p = 0;
    for (let { segment: d } of lo.segment(e)) {
      let g = fo(d);
      if (p + g > t) break;
      ((m += d), (p += g));
    }
    return { text: m, width: p };
  }
  let o = "",
    i = 0,
    a = 0,
    c = "";
  for (; a < e.length;) {
    let m = fr(e, a);
    if (m) {
      ((c += m.code), (a += m.length));
      continue;
    }
    if (e[a] === "	") {
      if (i + 3 > t) break;
      (c && ((o += c), (c = "")), (o += "	"), (i += 3), (a += 1));
      continue;
    }
    let p = a;
    for (; p < e.length && e[p] !== "	" && !fr(e, p);) p += 1;
    for (let { segment: d } of lo.segment(e.slice(a, p))) {
      let g = fo(d);
      if (i + g > t) return { text: o, width: i };
      (c && ((o += c), (c = "")), (o += d), (i += g));
    }
    a = p;
  }
  return { text: o, width: i };
}
function Ba(e, t, n, r, o, i) {
  let a = "\x1B[0m",
    c = wT(e),
    m = t + r,
    p = n.length > 0 ? `${e}${c}${a}${n}${a}` : `${e}${c}${a}`;
  return i ? p + " ".repeat(Math.max(0, o - m)) : p;
}
function Ja(e) {
  if (e.length === 0) return 0;
  if (Ga(e)) return e.length;
  let t = po.get(e);
  if (t !== void 0) return t;
  let n = e;
  if ((e.includes("	") && (n = n.replaceAll("	", "   ")), n.includes("\x1B"))) {
    let o = "",
      i = 0;
    for (; i < n.length;) {
      let a = fr(n, i);
      if (a) {
        i += a.length;
        continue;
      }
      ((o += n[i]), (i += 1));
    }
    n = o;
  }
  let r = 0;
  for (let { segment: o } of lo.segment(n)) r += fo(o);
  if (po.size >= bT) {
    let o = po.keys().next().value;
    o !== void 0 && po.delete(o);
  }
  return (po.set(e, r), r);
}
function za(e, t, n = "...", r = !1) {
  if (t <= 0) return "";
  if (e.length === 0) return r ? " ".repeat(t) : "";
  let o = Ja(n);
  if (o >= t) {
    let $ = Ja(e);
    if ($ <= t) return r ? e + " ".repeat(t - $) : e;
    let y = $T(n, t);
    return y.width === 0 ? (r ? " ".repeat(t) : "") : Ba("", 0, y.text, y.width, t, r);
  }
  if (Ga(e)) {
    if (e.length <= t) return r ? e + " ".repeat(t - e.length) : e;
    let $ = t - o;
    return Ba(e.slice(0, $), $, n, o, t, r);
  }
  let i = t - o,
    a = "",
    c = "",
    m = 0,
    p = 0,
    d = !0,
    g = !1,
    x = !1,
    I = e.includes("\x1B"),
    T = e.includes("	");
  if (!I && !T) {
    for (let { segment: $ } of lo.segment(e)) {
      let y = fo($);
      if ((d && p + y <= i ? ((a += $), (p += y)) : (d = !1), (m += y), m > t)) {
        g = !0;
        break;
      }
    }
    x = !g;
  } else {
    let $ = 0;
    for (; $ < e.length;) {
      let y = fr(e, $);
      if (y) {
        ((c += y.code), ($ += y.length));
        continue;
      }
      if (e[$] === "	") {
        if (
          (d && p + 3 <= i
            ? (c && ((a += c), (c = "")), (a += "	"), (p += 3))
            : ((d = !1), (c = "")),
          (m += 3),
          m > t)
        ) {
          g = !0;
          break;
        }
        $ += 1;
        continue;
      }
      let h = $;
      for (; h < e.length && e[h] !== "	" && !fr(e, h);) h += 1;
      for (let { segment: E } of lo.segment(e.slice($, h))) {
        let v = fo(E);
        if (
          (d && p + v <= i ? (c && ((a += c), (c = "")), (a += E), (p += v)) : ((d = !1), (c = "")),
          (m += v),
          m > t)
        ) {
          g = !0;
          break;
        }
      }
      if (g) break;
      $ = h;
    }
    x = $ >= e.length;
  }
  return !g && x ? (r ? e + " ".repeat(Math.max(0, t - m)) : e) : Ba(a, p, n, o, t, r);
}
var gr = class {
  text;
  constructor(t) {
    this.text = t;
  }
  render(t) {
    return [za(this.text, Math.max(1, t), "\u2026")];
  }
};
var Ut = {
    effect: "external_write",
    executionMode: "sequential",
    domains: ["cue", "execution"],
    modes: ["plan", "execute"],
    approval: "none",
  },
  Th = {
    effect: "external_write",
    executionMode: "sequential",
    domains: ["cue", "jobs"],
    modes: ["plan", "execute"],
    approval: "none",
  },
  vh = {
    effect: "read",
    executionMode: "parallel",
    domains: ["cue", "resources"],
    modes: ["plan", "execute", "fleet"],
    approval: "none",
  },
  Sh = {
    effect: "external_write",
    executionMode: "sequential",
    domains: ["cue", "schedules"],
    modes: ["execute"],
    approval: "none",
  },
  kh = {
    effect: "external_write",
    executionMode: "sequential",
    domains: ["cue", "scope"],
    modes: ["plan", "execute"],
    approval: "none",
  },
  _h = {
    effect: "read",
    executionMode: "parallel",
    domains: ["cue", "history"],
    modes: ["plan", "execute", "fleet"],
    approval: "none",
  };
function Et(e, t) {
  let n = t.effect ?? t.policy?.effect,
    r = t.executionMode ?? t.policy?.executionMode,
    o = t.requiresApproval ?? (t.policy?.approval === "required" ? !0 : void 0);
  e.registerTool({
    ...t,
    ...(n ? { effect: n } : {}),
    ...(r ? { executionMode: r } : {}),
    ...(o === !0 ? { requiresApproval: o } : {}),
  });
}
import { createHash as ZT } from "node:crypto";
import * as xo from "node:path";
function Rh(e, t, n, r = {}) {
  let o = TT(e),
    i = Ha(t, "baseMs"),
    a = Ha(n, "maxMs"),
    c = Math.max(0, o - 1),
    m = r.exponentCap === void 0 ? c : Math.min(c, Ph(r.exponentCap, "options.exponentCap"));
  return Math.min(a, i * 2 ** m);
}
function Oh(e, t = Math.random) {
  let n = Ph(e, "ceilingMs"),
    r = t();
  if (!Number.isFinite(r)) throw new RangeError("random() must return a finite number");
  let o = Math.max(0, Math.min(1, r));
  return Math.floor(n * (0.5 + o * 0.5));
}
function Ph(e, t) {
  return Math.floor(Ha(e, t));
}
function Ha(e, t) {
  if (!Number.isFinite(e) || e < 0)
    throw new RangeError(`${t} must be a finite non-negative number`);
  return e;
}
function TT(e) {
  if (!Number.isFinite(e)) throw new RangeError("attempt must be a finite number");
  return Math.max(0, Math.floor(e));
}
import { spawn as vT } from "node:child_process";
import * as go from "node:path";
var jh = 1e4,
  Ah = 32 * 1024;
async function Lh(e) {
  let t = await qi();
  await ST(t, e);
}
async function ST(e, t) {
  let n = [],
    r = [],
    o = e.daemon.command,
    i = [...e.daemon.args, "start", "--socket", t];
  return new Promise((a, c) => {
    let m = vT(o, i, { detached: !0, env: dr(), stdio: ["ignore", "pipe", "pipe"] }),
      p = kT("PI_CUE_AUTOSTART_TIMEOUT_MS", jh),
      d = !1,
      g,
      x = (I) => {
        d || ((d = !0), g && clearTimeout(g), I());
      };
    (m.stdout?.on("data", (I) => Mh(n, I)),
      m.stderr?.on("data", (I) => Mh(r, I)),
      m.on("error", (I) => {
        x(() =>
          c(new Error(Wa({ command: o, args: i, socketPath: t, error: I, stdout: n, stderr: r }))),
        );
      }),
      m.on("close", (I, T) => {
        x(() => {
          I === 0 || I === null
            ? setTimeout(a, 500)
            : c(
                new Error(
                  Wa({
                    command: o,
                    args: i,
                    socketPath: t,
                    code: I,
                    signal: T,
                    stdout: n,
                    stderr: r,
                  }),
                ),
              );
        });
      }),
      p > 0 &&
        ((g = setTimeout(() => {
          (m.kill("SIGTERM"),
            m.stdout?.destroy(),
            m.stderr?.destroy(),
            x(() =>
              c(
                new Error(
                  Wa({
                    command: o,
                    args: i,
                    socketPath: t,
                    error: new Error(`${[o, ...i].join(" ")} timed out after ${p}ms`),
                    stdout: n,
                    stderr: r,
                  }),
                ),
              ),
            ));
        }, p)),
        g.unref?.()),
      m.unref());
  });
}
function kT(e, t) {
  let n = process.env[e];
  if (!n) return t;
  let r = Number(n);
  return Number.isFinite(r) ? Math.max(0, Math.floor(r)) : t;
}
function Mh(e, t) {
  e.push(Buffer.from(t));
  let n = e.reduce((r, o) => r + o.length, 0);
  for (; n > Ah && e.length > 0;) {
    let r = e[0];
    if (!r) break;
    let o = n - Ah;
    r.length <= o ? (e.shift(), (n -= r.length)) : ((e[0] = r.subarray(o)), (n -= o));
  }
}
function Wa(e) {
  let t = [e.command, ...e.args].join(" "),
    n = `${t} exited with code ${e.code}`;
  e.error ? (n = e.error.message) : e.signal && (n = `${t} terminated by signal ${e.signal}`);
  let r = Buffer.concat(e.stdout).toString("utf8").trim(),
    o = Buffer.concat(e.stderr).toString("utf8").trim(),
    i = [
      n,
      `Attempted: ${t}`,
      `Socket: ${e.socketPath}`,
      `Socket directory: ${go.dirname(e.socketPath)}`,
      `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "<unset>"}`,
      `TMPDIR=${process.env.TMPDIR ?? "<unset>"}`,
      `Config directory: ${_T()}`,
    ];
  return (
    i.push(
      o
        ? `stderr:
${o}`
        : "stderr: <empty>",
    ),
    i.push(
      r
        ? `stdout:
${r}`
        : "stdout: <empty>",
    ),
    i.push(
      `Recovery: run ${JSON.stringify(`${t.replace(" start", " start --fg")}`)} in a terminal for daemon logs; check for a stale socket at ${e.socketPath}; after protocol upgrades, restart/reload the Spark host so its spark-cue client matches the daemon.`,
    ),
    i.join(`
`)
  );
}
function _T() {
  return process.env.XDG_CONFIG_HOME?.trim()
    ? go.join(process.env.XDG_CONFIG_HOME, "cue-shell")
    : process.env.HOME?.trim()
      ? go.join(process.env.HOME, ".config", "cue-shell")
      : "<unknown: HOME unset>";
}
import { mkdir as PT, readFile as AT, writeFile as MT } from "node:fs/promises";
import { dirname as jT } from "node:path";
import Xa from "node:process";
import { homedir as RT } from "node:os";
import { join as de, resolve as OT } from "node:path";
function Nh(e = {}) {
  let t = e.env ?? process.env,
    n = e.cwd ?? process.cwd(),
    r = hr(t.HOME) ?? RT(),
    o = hr(e.sparkHome) ?? hr(t.SPARK_HOME),
    i = o ? Va(o, n) : void 0,
    a = i ?? de(zi(t.XDG_CONFIG_HOME, r, ".config", n), "spark"),
    c = i ?? de(zi(t.XDG_DATA_HOME, r, ".local/share", n), "spark"),
    m = i ?? de(zi(t.XDG_CACHE_HOME, r, ".cache", n), "spark"),
    p = i ?? de(zi(t.XDG_STATE_HOME, r, ".local/state", n), "spark"),
    d = i || (hr(t.XDG_RUNTIME_DIR) ? de(Va(hr(t.XDG_RUNTIME_DIR), n), "spark") : p),
    g = i ?? c,
    x = de(a, "agent");
  return {
    configRoot: a,
    dataRoot: c,
    cacheRoot: m,
    stateRoot: p,
    runtimeRoot: d,
    root: g,
    configFile: de(a, "config.json"),
    authFile: de(a, "auth.json"),
    sessionsDir: de(c, "sessions"),
    askConfigFile: de(a, "ask.json"),
    rolesDir: de(r, ".agents", "roles"),
    roleModelSettingsFile: de(a, "role-model-settings.json"),
    workflowsDir: de(r, ".agents", "workflows"),
    userAgentsSkillsDir: de(r, ".agents", "skills"),
    promptTemplatesDir: de(a, "prompts"),
    themesDir: de(a, "themes"),
    memoryDir: de(c, "memory"),
    learningsDir: de(c, "memory", "learnings"),
    recallFile: de(c, "memory", "recall-candidates.json"),
    memoryFile: de(c, "memory", "memory.json"),
    agentDir: x,
    keybindingsFile: de(x, "keybindings.json"),
    exportsDir: de(c, "exports"),
    shareDir: de(c, "share"),
    workspacesDir: de(c, "workspaces"),
    cueVersionCacheFile: i ? de(m, "cache", "cued-version.json") : de(m, "cued-version.json"),
  };
}
function zi(e, t, n, r) {
  return Va(hr(e) ?? de(t, n), r);
}
function hr(e) {
  return e?.trim() || void 0;
}
function Va(e, t) {
  return OT(t, e);
}
import { DatabaseSync as gY } from "node:sqlite";
var hY = 256 * 1024,
  xY = 256 * 1024 * 1024,
  yY = 256 * 1024 * 1024,
  bY = 384 * 1024 * 1024,
  IY = 64 * 1024 * 1024;
var LT = "https://api.github.com/repos/zendev-lab/cue/releases/latest",
  NT = 360 * 60 * 1e3,
  DT = 4e3,
  FT = "warning",
  Dh = "PI_CUE_NO_VERSION_CHECK",
  qT = "PI_CUE_VERSION_CACHE_TTL_MS",
  UT = "PI_CUE_LATEST_RELEASE_URL",
  Hi = !1;
function KT(e, t) {
  return t === null
    ? e.kind === "unknown"
      ? { kind: "no-latest", daemon: e }
      : { kind: "match" }
    : e.kind === "unknown"
      ? { kind: "unknown-running", latest: t }
      : QT(e.version, t) < 0
        ? { kind: "outdated", daemon: e, latest: t }
        : { kind: "match" };
}
function BT(e) {
  if (e.kind === "match" || e.kind === "no-latest") return null;
  let t = [];
  return (
    e.kind === "unknown-running"
      ? t.push(
          `spark-cue: cued does not report its version; latest cue-shell release is ${e.latest}.`,
        )
      : t.push(
          `spark-cue: cued ${e.daemon.kind === "reported" ? e.daemon.version : "(unknown)"} is older than latest cue-shell release ${e.latest}.`,
        ),
    t.push("  Self-update + restart:  cued upgrade"),
    t.push("  Or just restart:        cued restart"),
    t.push(`  Suppress with ${Dh}=1.`),
    t.join(`
`)
  );
}
async function Fh(e, t, n) {
  if (Hi) return null;
  if (YT(Dh)) return ((Hi = !0), null);
  let r;
  try {
    let c = await e.pingForVersion();
    r = c !== null && c.length > 0 ? { kind: "reported", version: c } : { kind: "unknown" };
  } catch (c) {
    return (console.debug("[spark-cue] version check ping failed; skipping warning", c), null);
  }
  let o = await JT(n?.latest),
    i = KT(r, o),
    a = BT(i);
  return a === null
    ? ((Hi = !0), i)
    : ((Hi = !0), t?.ui?.notify ? t.ui.notify(a, FT) : console.warn(a), i);
}
async function JT(e) {
  if (e !== void 0) {
    if (typeof e == "function")
      try {
        return await e();
      } catch (t) {
        return (console.debug("[spark-cue] version check latest override failed", t), null);
      }
    return e;
  }
  return await GT();
}
async function GT() {
  let e = Xa.env[UT] ?? LT,
    t = XT(Xa.env[qT]) ?? NT,
    n = zT(),
    r = await HT(n);
  if (r && r.url === e && Date.now() - r.fetchedAt < t) return r.tag;
  let o = await VT(e);
  return (await WT(n, { url: e, tag: o, fetchedAt: Date.now() }), o);
}
function zT() {
  return Nh().cueVersionCacheFile;
}
async function HT(e) {
  try {
    let t = await AT(e, "utf-8"),
      n = JSON.parse(t);
    return typeof n.url == "string" &&
      typeof n.fetchedAt == "number" &&
      (n.tag === null || typeof n.tag == "string")
      ? { url: n.url, tag: n.tag, fetchedAt: n.fetchedAt }
      : null;
  } catch (t) {
    return (console.debug(`[spark-cue] version cache read failed for ${e}`, t), null);
  }
}
async function WT(e, t) {
  try {
    (await PT(jT(e), { recursive: !0 }), await MT(e, JSON.stringify(t), "utf-8"));
  } catch (n) {
    console.debug(`[spark-cue] version cache write failed for ${e}`, n);
  }
}
async function VT(e) {
  let t = new AbortController(),
    n = setTimeout(() => t.abort(), DT);
  try {
    let r = await fetch(e, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "spark-cue version-check",
      },
      signal: t.signal,
    });
    if (!r.ok) return null;
    let o = await r.json();
    return typeof o.tag_name != "string" || o.tag_name.length === 0 ? null : qh(o.tag_name);
  } catch (r) {
    return (console.debug(`[spark-cue] latest release fetch failed for ${e}`, r), null);
  } finally {
    clearTimeout(n);
  }
}
function qh(e) {
  return e.startsWith("v") ? e.slice(1) : e;
}
function XT(e) {
  if (!e) return null;
  let t = Number.parseInt(e, 10);
  return !Number.isFinite(t) || t < 0 ? null : t;
}
function YT(e) {
  let t = Xa.env[e];
  return t ? t === "1" || t.toLowerCase() === "true" || t.toLowerCase() === "yes" : !1;
}
function QT(e, t) {
  let n = (a) =>
      qh(a)
        .split(/[.+-]/)
        .map((c) => {
          let m = Number.parseInt(c, 10);
          return Number.isFinite(m) && /^\d+$/.test(c) ? m : c;
        }),
    r = n(e),
    o = n(t),
    i = Math.max(r.length, o.length);
  for (let a = 0; a < i; a += 1) {
    let c = r[a],
      m = o[a];
    if (c === void 0) return -1;
    if (m === void 0) return 1;
    if (typeof c == "number" && typeof m == "number") {
      if (c !== m) return c < m ? -1 : 1;
      continue;
    }
    let p = String(c),
      d = String(m);
    if (p !== d) return p < d ? -1 : 1;
  }
  return 0;
}
function Jh(e, t) {
  let n = t?.trim() || process.cwd();
  return e ? (xo.isAbsolute(e) ? e : xo.resolve(n, e)) : xo.resolve(n);
}
var gt = new Map();
function Vi(e) {
  if ((gt.get(e.key) === e && gt.delete(e.key), e.client)) {
    e.client.close();
    return;
  }
  e.connectPromise.then(
    (t) => t.close(),
    () => {},
  );
}
function ev(e) {
  return e.transport === "unix"
    ? `unix:${e.socket_path}`
    : ["ssh", e.profile_name, e.destination, e.gateway_command].join(":");
}
function ho(e) {
  return e instanceof Error ? e.message : String(e);
}
function Xi(e) {
  let t = Jh(void 0, e?.cwd);
  return {
    sessionId: Gh(e, t),
    cwd: t,
    env: e?.env ?? process.env,
    refresh: !1,
    forwardSensitiveEnv: e?.cueForwardSensitiveEnv ?? !1,
  };
}
function Gh(e, t) {
  let n = e?.sessionId?.trim();
  if (n) return n;
  let r = e?.sessionManager?.getSessionFile?.()?.trim();
  if (r) return `session:${Uh(r)}`;
  let o = e?.sessionManager?.getLeafId?.()?.trim();
  if (o) return `leaf:${o}`;
  let i = process.env.PI_SESSION_ID?.trim() || process.env.SPARK_SESSION_ID?.trim();
  return i || `spark-cue:${process.pid}:${Uh(t)}`;
}
function Uh(e) {
  return ZT("sha256").update(e).digest("hex").slice(0, 32);
}
function Ya(e, t) {
  let n = Array.from(gt.values()).filter((i) => i.owners.has(e)),
    o = !!(
      t?.sessionId?.trim() ||
      t?.cwd?.trim() ||
      t?.sessionManager?.getSessionFile?.()?.trim() ||
      t?.sessionManager?.getLeafId?.()?.trim() ||
      process.env.PI_SESSION_ID?.trim() ||
      process.env.SPARK_SESSION_ID?.trim()
    )
      ? Gh(t, Jh(void 0, t?.cwd))
      : void 0;
  if (!o) {
    let i = new Set(n.map((a) => a.sessionId));
    if (i.size !== 1) return;
    o = i.values().next().value;
  }
  for (let i of n) i.sessionId === o && i.owners.delete(e) && i.owners.size === 0 && Vi(i);
}
function zh(e) {
  for (let t of Array.from(gt.values())) t.owners.delete(e) && t.owners.size === 0 && Vi(t);
}
async function tv(e, t, n) {
  try {
    return await Un.connectResolved(e, t);
  } catch (r) {
    if (
      (r instanceof _ && r.code === "UNSUPPORTED_PROTOCOL") ||
      e.transport === "ssh" ||
      !(r instanceof _) ||
      r.code !== "DAEMON_UNREACHABLE" ||
      n?.cueAutoStartLocal === !1
    )
      throw r;
    n?.ui?.notify?.("cue-shell: auto-starting daemon\u2026", "info");
    try {
      await Lh(e.socket_path);
    } catch (o) {
      let i = [
        `cue-shell daemon not reachable at ${e.socket_path}.`,
        `Initial connection failure: ${ho(r)}`,
        `Auto-start failed: ${ho(o)}`,
      ].join(`
`);
      throw new _("DAEMON_UNREACHABLE", i);
    }
    try {
      return await Un.connectResolved(e, t);
    } catch (o) {
      if (o instanceof _ && o.code === "UNSUPPORTED_PROTOCOL") throw o;
      let i = [
        `cue-shell daemon auto-started but still not reachable at ${e.socket_path}.`,
        `Initial connection failure: ${ho(r)}`,
        `Retry failure: ${ho(o)}`,
      ].join(`
`);
      throw new _("DAEMON_UNREACHABLE", i);
    }
  }
}
async function ln(e, t) {
  if (e?.cueClient) return e.cueClient;
  let n = e?.cueResolvedTransport ?? (await Dn()),
    r =
      n.transport === "ssh"
        ? (() => {
            let m =
              e?.cueRemoteCwd?.trim() ||
              e?.env?.SPARK_CUE_REMOTE_CWD?.trim() ||
              process.env.SPARK_CUE_REMOTE_CWD?.trim();
            if (!m)
              throw new Error(
                `cue profile \`${n.profile_name}\` uses SSH; provide an explicit remote cwd instead of reusing the local session cwd.`,
              );
            return { ...e, cwd: m };
          })()
        : e,
    o = Xi(r),
    i = `${ev(n)}|session:${o.sessionId}`,
    a = gt.get(i);
  if ((a?.client?.isClosed && (Vi(a), (a = void 0)), !a)) {
    let m = { key: i, sessionId: o.sessionId, owners: new Set(), connectPromise: tv(n, o, e) };
    ((m.connectPromise = m.connectPromise
      .then((p) => ((m.client = p), (gt.get(i) !== m || m.owners.size === 0) && p.close(), p))
      .catch((p) => {
        throw (gt.get(i) === m && gt.delete(i), p);
      })),
      (a = m),
      gt.set(i, a));
  }
  a.owners.add(t);
  let c = await a.connectPromise;
  if (c.isClosed)
    throw (
      Vi(a),
      new _(
        "DAEMON_UNREACHABLE",
        `cue-shell connection closed during initialization for session ${o.sessionId}`,
      )
    );
  return (Fh(c, e), c);
}
function tt(e, t, n) {
  return { sessionId: Xi(e).sessionId, toolCallId: t, kind: n };
}
async function Kh(e) {
  for (let t of [...gt.values()]) t.client === e && gt.get(t.key) === t && gt.delete(t.key);
  (e.close(), await e.closed);
}
var nv = 100,
  rv = 5e3;
function ov(e) {
  let t = Rh(e, nv, rv, { exponentCap: 16 });
  return Oh(t);
}
function Bh(e) {
  return new _(
    "IDEMPOTENT_RETRY_DEADLINE_EXCEEDED",
    `operation ${e} remained transport-ambiguous when its retry deadline expired`,
  );
}
async function Wi(e, t, n, r) {
  if ((n?.throwIfAborted(), r !== void 0 && Date.now() >= r)) throw Bh(t);
  return !n && r === void 0
    ? e
    : new Promise((o, i) => {
        let a = !1,
          c,
          m = (d) => {
            a || ((a = !0), c && clearTimeout(c), n?.removeEventListener("abort", p), d());
          },
          p = () => m(() => i(n?.reason ?? new DOMException("Aborted", "AbortError")));
        if ((n && n.addEventListener("abort", p, { once: !0 }), n?.aborted)) {
          p();
          return;
        }
        (r !== void 0 && (c = setTimeout(() => m(() => i(Bh(t))), Math.max(0, r - Date.now()))),
          e.then(
            (d) => m(() => o(d)),
            (d) => m(() => i(d)),
          ));
      });
}
function iv(e, t, n, r) {
  return Wi(new Promise((o) => setTimeout(o, e)), t, n, r);
}
function sv(e) {
  return ({ attempt: t, delayMs: n, remainingMs: r }) => {
    let o = r === void 0 ? "" : `; ${Math.ceil(r / 1e3)}s left`;
    e({
      content: [
        {
          type: "text",
          text: `cue-shell transport interrupted; retrying attempt ${t} in ${n}ms${o}`,
        },
      ],
    });
  };
}
function nt(e, t, n = {}) {
  return { ...n, signal: e, onRetry: sv(t) };
}
async function rt(e, t, n, r, o = {}) {
  let i = Fa(n),
    a = o.deadlineMs === void 0 ? void 0 : Date.now() + Math.max(0, o.deadlineMs),
    c = (x) => {
      if (a === void 0) return { attempt: x };
      let I = Math.max(0, a - Date.now());
      return { attempt: x, remainingMs: I };
    },
    m = await Wi(ln(e, t), i, o.signal, a),
    p = m.daemonInstanceId,
    d = m,
    g = 1;
  for (;;)
    try {
      return await Wi(r(d, c(g)), i, o.signal, a);
    } catch (x) {
      if (!la(x)) throw x;
      if (e?.cueClient)
        throw new _(
          "IDEMPOTENT_RETRY_UNAVAILABLE",
          `operation ${i} became transport-ambiguous, and an externally injected CueClient cannot be rebuilt safely: ${ho(x)}`,
        );
      if (o.replaySafe === !1)
        throw new _(
          "IDEMPOTENT_RECOVERY_UNSUPPORTED",
          `operation ${i} may have executed, but its result cannot yet be reconstructed after reconnect`,
        );
      for (await Kh(d); ;) {
        let I = g + 1,
          T = ov(g),
          $ = a === void 0 ? void 0 : Math.max(0, a - Date.now());
        (o.onRetry?.({ attempt: I, delayMs: T, remainingMs: $ }), await iv(T, i, o.signal, a));
        let y;
        try {
          y = await Wi(ln(e, t), i, o.signal, a);
        } catch (h) {
          if (h instanceof _ && h.code === "DAEMON_UNREACHABLE") {
            g = I;
            continue;
          }
          throw h;
        }
        if (p === null || y.daemonInstanceId === null || y.daemonInstanceId !== p) {
          let h = y.daemonInstanceId;
          throw (
            await Kh(y),
            new _(
              "IDEMPOTENT_DAEMON_CHANGED",
              `operation ${i} cannot be replayed because cued changed from instance ${p ?? "unknown"} to ${h ?? "unknown"}`,
            )
          );
        }
        ((d = y), (g = I));
        break;
      }
    }
}
var uv = new Set([
    "mv",
    "cp",
    "rm",
    "mkdir",
    "rmdir",
    "ln",
    "touch",
    "chmod",
    "chown",
    "ls",
    "cat",
    "echo",
    "pwd",
    "which",
    "wc",
    "head",
    "tail",
    "file",
    "find",
    "fd",
    "rg",
    "grep",
    "stat",
    "readlink",
    "dirname",
    "basename",
    "true",
    "false",
    "test",
    "[",
  ]),
  cv = 10,
  wt = 16 * 1024,
  Qi = 20,
  mv = ["list", "status", "wait", "stop"],
  pv = ["providers", "resources"],
  dv = /^[A-Za-z0-9_.:-]+$/,
  lv = ["all", "running", "pending", "done", "failed", "killed", "cancelled"],
  fv = ["add", "list", "pause", "resume", "remove"],
  gv = ["all", "scheduled", "paused", "completed", "expired", "failed"],
  hv = ["list", "env", "config", "env_set", "env_unset", "path_prepend", "cd", "refresh", "status"],
  Wh = ["cue-shell", "python"],
  xv = new Set([
    "basename",
    "cat",
    "dirname",
    "file",
    "grep",
    "head",
    "ls",
    "pwd",
    "readlink",
    "rg",
    "stat",
    "tail",
    "wc",
    "which",
  ]),
  yv = new Set(["--files-from", "--path-separator", "--pre", "--pre-glob", "--replace"]);
function bv(e) {
  let t = e.trim().split(/\s+/)[0];
  if (!t) return !1;
  let n = t.split("/").pop() ?? t;
  return uv.has(n);
}
function Iv(e) {
  if (e.background === !0 || e.pty === !0 || e.needs !== void 0) return Ut;
  let t = typeof e.command == "string" ? e.command.trim() : "";
  if (!t || /[\n\r|&;`$()<>~'"\\]/u.test(t)) return Ut;
  let n = t.split(/\s+/u),
    r = n[0];
  return !r || r.includes("/") || !xv.has(r)
    ? Ut
    : n.slice(1).some((o) => [...yv].some((i) => o === i || o.startsWith(`${i}=`)))
      ? Ut
      : {
          effect: "read",
          executionMode: "sequential",
          domains: ["cue", "safe-exec"],
          phases: ["plan", "implement"],
          approval: "none",
        };
}
function yr(e) {
  switch (e) {
    case "Running":
      return "\u{1F7E2} running";
    case "Done":
      return "\u2705 done";
    case "Failed":
      return "\u274C failed";
    case "Killed":
      return "\u23F9\uFE0F killed";
    case "Cancelled":
      return "\u{1F6AB} cancelled";
    case "Pending":
      return "\u23F3 pending";
    default:
      return e;
  }
}
function Ge(e, t) {
  if (t <= 0) throw new Error("tail byte limit must be a positive integer");
  return e.length <= t
    ? { text: e, truncated: !1 }
    : { text: e.slice(e.length - t), truncated: !0 };
}
function Cv(e, t) {
  let n = e.source.kind === "file" ? e.source.path : t.pathLabel,
    r = [
      `Script ${e.scriptId}: ${e.status === "done" ? "\u2705 done" : e.status === "running" ? "\u23F3 running" : "\u274C failed"}`,
    ];
  (e.exitCode !== null && r.push(`exit=${e.exitCode}`),
    e.failedItemIndex !== null && r.push(`failed_item=${e.failedItemIndex}`),
    r.push(`source=${n}`),
    e.timedOut && r.push("timed_out=true"));
  let o = [r.join("  |  ")];
  e.timedOut &&
    o.push(
      `Script wait budget elapsed after ${t.timeout}s; the script remains running. Track with cue_jobs.`,
    );
  let i = [],
    a = () => {
      i.length !== 0 && (o.push("", wv(i)), (i = []));
    };
  for (let c of e.items) {
    if (Ev(c)) {
      i.push(c);
      continue;
    }
    a();
    let m = px(c),
      p = c.kind === "message" ? "\u2139\uFE0F message" : yr(c.status),
      d = c.exitCode !== null && c.exitCode !== 0 ? ` (exit ${c.exitCode})` : "";
    if (
      (o.push(""),
      o.push(`--- item ${c.index}: ${c.source} [${m}] ${p}${d}`),
      c.kind === "message" && c.message)
    ) {
      o.push(c.message.trimEnd());
      continue;
    }
    let g = xn(c.stdout),
      x = br(c.stderr, g);
    if (g.trim()) {
      let I = Ge(g, t.tailBytes);
      (o.push(I.text.trimEnd()),
        I.truncated &&
          o.push(
            `[stdout truncated \u2014 use cue_jobs action=status id=${c.jobIds[0] ?? "?"} with a larger bounded tail_bytes value]`,
          ));
    }
    if (x.trim()) {
      let I = Ge(x, t.tailBytes);
      (o.push("[stderr]"),
        o.push(I.text.trimEnd()),
        I.truncated &&
          o.push(
            `[stderr truncated \u2014 use cue_jobs action=status id=${c.jobIds[0] ?? "?"} with a larger bounded tail_bytes value]`,
          ));
    }
  }
  return (a(), o);
}
function Ev(e) {
  if (e.kind === "message" || e.status !== "Done" || (e.exitCode !== null && e.exitCode !== 0))
    return !1;
  let t = xn(e.stdout),
    n = br(e.stderr, t);
  return !t.trim() && !n.trim();
}
function wv(e) {
  let n = e
      .slice(0, 8)
      .map((o) => `${o.index}:${px(o)}`)
      .join(", "),
    r = e.length > 8 ? `, +${e.length - 8} more` : "";
  return `--- ${e.length} clean item(s) done with no output (${n}${r})`;
}
function px(e) {
  switch (e.kind) {
    case "chain":
      return `chain ${e.chainId ?? "?"} (${e.jobIds.join(",")})`;
    case "job":
      return `job ${e.jobIds[0] ?? "?"}`;
    case "cron":
      return `cron ${e.cronId ?? "?"}`;
    case "message":
      return "message";
  }
}
var $v = new RegExp(String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`, "g"),
  Tv = new RegExp(String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`, "g");
function vv(e) {
  return e.replaceAll($v, "").replaceAll(Tv, "");
}
function Sv(e) {
  let t = e.replaceAll(
      `\r
`,
      `
`,
    ),
    n = [],
    r = "";
  for (let o = 0; o < t.length; o += 1) {
    let i = t[o];
    if (i === "\r") {
      r = "";
      continue;
    }
    if (
      i ===
      `
`
    ) {
      (n.push(r), (r = ""));
      continue;
    }
    r += i;
  }
  return (
    n.push(r),
    n.join(`
`)
  );
}
function kv(e) {
  let t = e.replace(/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◒◐◓◑⣾⣽⣻⢿⡿⣟⣯⣷|/\\-]\s+/, "");
  if (t !== e) return t.trim() || void 0;
}
function _v(e) {
  let t = e.split(`
`),
    n = [],
    r;
  for (let o of t) {
    let i = kv(o);
    if (i && i === r) {
      n[n.length - 1] = o;
      continue;
    }
    (n.push(o), (r = i));
  }
  return n.join(`
`);
}
function xn(e) {
  return e && _v(Sv(vv(e)));
}
var Vh = "[PTY: stdout and stderr are merged]";
function br(e, t = "") {
  let n = xn(e);
  if (!n.includes(Vh)) return n;
  let r = n
      .split(/\r?\n/)
      .filter((i) => i.trim() !== Vh)
      .join(`
`)
      .replace(/^\r?\n/, ""),
    o = xn(t);
  return !r.trim() || r.trimEnd() === o.trimEnd() ? "" : r;
}
function Xh(e) {
  return e.length === 0 ? [] : ["", "[warnings]", ...e];
}
function Yh(e) {
  return e.length === 0
    ? ""
    : `

[warnings]
${e.join(`
`)}`;
}
function Qh(e, t) {
  let n = new Error(e);
  throw ((n.details = t), n);
}
function eu(e) {
  return e === "Done" || e === "Failed" || e === "Killed" || e === "Cancelled";
}
function Zh(e, t) {
  return e
    .filter((n) => n.chain_id != null && String(n.chain_id) === t)
    .sort((n, r) => (n.chain_index ?? 0) - (r.chain_index ?? 0));
}
function tu(e) {
  let t = e.find((n) => n.status !== "Done" && eu(n.status));
  return t
    ? t.status
    : e.every((n) => n.status === "Done")
      ? "Done"
      : e.some((n) => n.status === "Running")
        ? "Running"
        : "Pending";
}
function Io(e) {
  return typeof e.pending_reason == "string" && e.pending_reason.trim()
    ? e.pending_reason.trim()
    : void 0;
}
function nu(e, t) {
  let n = Io(e);
  n && t.push(`Pending reason: ${n}`);
}
function Rv(e) {
  let t = `${e.id}  ${yr(e.status)}  ${e.pipeline}`;
  (e.exit_code != null && (t += ` (exit ${e.exit_code})`), e.chain_id && (t += ` [${e.chain_id}]`));
  let n = Io(e);
  return (n && (t += ` \u2014 pending: ${n}`), t);
}
async function dx(e, t, n) {
  let r = await e.jobOutput(t.id, n),
    o = [],
    i = xn(r.stdout),
    a = Ge(i, n);
  (a.text.trim() && o.push("", a.text.trimEnd()),
    (a.truncated || r.truncated) && o.push("[stdout truncated]"));
  let c = Ge(br(r.stderr, i), n);
  return (
    c.text.trim() && o.push("", "[stderr]", c.text.trimEnd()),
    (c.truncated || r.stderrTruncated) && o.push("[stderr truncated]"),
    { lines: o, hasOutput: o.length > 0 }
  );
}
async function ex(e, t, n, r) {
  let o = await dx(e, t, r);
  n.push(...o.lines);
}
async function tx(e, t, n, r) {
  let o = tu(n),
    i = [];
  for (let d of n) {
    let g = await dx(e, d, r),
      I = [
        `${`Leaf ${(d.chain_index ?? 0) + 1}/${d.chain_total ?? n.length}`}: ${yr(d.status)} \u2014 ${d.pipeline}`,
      ];
    (d.exit_code != null && I.push(`Exit code: ${d.exit_code}`),
      nu(d, I),
      I.push(...g.lines),
      i.push({
        job: d,
        lines: I,
        clean: d.status === "Done" && (d.exit_code == null || d.exit_code === 0) && !g.hasOutput,
      }));
  }
  let a = [`${yr(o)} \u2014 chain ${t}`],
    c = i.filter((d) => !d.clean && d.job.status !== "Done"),
    m = i.filter((d) => !d.clean && d.job.status === "Done"),
    p = i.filter((d) => d.clean);
  for (let d of [...c, ...m]) a.push("", ...d.lines);
  return (p.length > 0 && a.push("", Ov(p)), a);
}
function Ov(e) {
  let n = e
      .slice(0, 8)
      .map((o) => `leaf ${(o.job.chain_index ?? 0) + 1}:${o.job.id}`)
      .join(", "),
    r = e.length > 8 ? `, +${e.length - 8} more` : "";
  return `--- ${e.length} clean successful leaf(s) done with no output (${n}${r})`;
}
function nx(e) {
  return e.length === 1 ? (e[0] ?? "") : `${e.slice(0, -1).join(", ")}, or ${e[e.length - 1]}`;
}
function fn(e, t, n, r) {
  if (e == null) {
    if (t !== void 0) return t;
    throw new Error(`${r} is required`);
  }
  if (typeof e != "string" || !e.trim()) throw new Error(`${r} must be ${nx(n)}`);
  let o = e.trim().toLowerCase();
  if (!n.includes(o)) throw new Error(`${r} must be ${nx(n)}`);
  return o;
}
function gn(e, t = wt, n = "tail_bytes") {
  if (e == null) return t;
  if (typeof e != "number" || !Number.isFinite(e)) throw new Error(`${n} must be a finite number`);
  if (!Number.isInteger(e) || e <= 0) throw new Error(`${n} must be a positive integer`);
  return e;
}
function Yi(e, t = Qi, n = "limit") {
  if (e == null) return t;
  if (typeof e != "number" || !Number.isFinite(e)) throw new Error(`${n} must be a finite number`);
  if (!Number.isInteger(e) || e <= 0) throw new Error(`${n} must be a positive integer`);
  return e;
}
function xr(e, t, n = "timeout") {
  if (e == null) return t;
  if (typeof e != "number" || !Number.isFinite(e)) throw new Error(`${n} must be a finite number`);
  if (e < 0) throw new Error(`${n} must be non-negative`);
  return e;
}
function Qa(e, t, n) {
  if (e == null) return t;
  if (typeof e != "boolean") throw new Error(`${n} must be a boolean`);
  return e;
}
function Zi(e, t, n = process.cwd()) {
  let r = t?.trim() ? t.trim() : n;
  return e ? ($t.isAbsolute(e) ? e : $t.resolve(r, e)) : $t.resolve(r);
}
async function yo(e, t) {
  if (t.taskExecutionScope && (t.cueRemoteCwd || t.cueResolvedTransport?.transport === "ssh"))
    throw new Error("Task execution scope forbids remote Cue execution");
  if (t.cueClient) return { cwd: await rx(Zi(e, t.cwd), t), ctx: t };
  let n = await Dn();
  if (n.transport === "ssh") {
    if (t.taskExecutionScope) throw new Error("Task execution scope forbids remote Cue execution");
    let o =
      e ??
      t.cueRemoteCwd?.trim() ??
      t.env?.SPARK_CUE_REMOTE_CWD?.trim() ??
      process.env.SPARK_CUE_REMOTE_CWD?.trim();
    if (!o)
      throw new Error(
        `cue_exec profile \`${n.profile_name}\` uses SSH; provide cwd as a path that exists on ${n.destination}. Local session paths are not mapped to remote hosts.`,
      );
    if (!$t.posix.isAbsolute(o))
      throw new Error(`cue_exec SSH cwd must be an absolute remote path (got ${o}).`);
    return { cwd: o, ctx: { ...t, cwd: o, cueRemoteCwd: o, cueResolvedTransport: n } };
  }
  return { cwd: await rx(Zi(e, t.cwd), t), ctx: { ...t, cueResolvedTransport: n } };
}
async function rx(e, t) {
  let n = t.taskExecutionScope;
  if (!n) return e;
  if (n.isolation === "readonly") throw new Error("Task execution scope is readonly");
  let r = await Hh(e),
    o =
      n.isolation === "isolated_results" ? (n.resultsRoot ? [n.resultsRoot] : []) : n.writableRoots;
  for (let i of o) {
    let a = await Hh(i),
      c = $t.relative(a, r);
    if (c === "" || (c !== ".." && !c.startsWith(`..${$t.sep}`))) return r;
  }
  throw new Error(`Cue cwd escapes the daemon-authorized Task scope: ${r}`);
}
function Pv(e) {
  let t;
  for (let n = 0; n < e.length; n += 1) {
    let r = e[n];
    if (r === "\\" && t !== "single") {
      n += 1;
      continue;
    }
    if (t === "single") {
      r === "'" && (t = void 0);
      continue;
    }
    if (t === "double") {
      r === '"' && (t = void 0);
      continue;
    }
    if (r === "'") {
      t = "single";
      continue;
    }
    if (r === '"') {
      t = "double";
      continue;
    }
    if (
      r === "|" &&
      e[n + 1] !== ">" &&
      !(e[n + 1] === "&" && e[n + 2] === ">") &&
      !(e[n + 1] === "?" && e[n + 2] === "|") &&
      e[n + 1] !== "|"
    )
      return `${e.slice(0, n)}|>${e.slice(n + 1)}`;
  }
}
function Av(e) {
  let t;
  for (let n = 0; n < e.length; n += 1) {
    let r = e[n];
    if (r === "\\" && t !== "single") {
      n += 1;
      continue;
    }
    if (t === "single") {
      r === "'" && (t = void 0);
      continue;
    }
    if (t === "double") {
      r === '"' && (t = void 0);
      continue;
    }
    if (r === "'") {
      t = "single";
      continue;
    }
    if (r === '"') {
      t = "double";
      continue;
    }
    if (r === ";") {
      let o = n > 0 ? e[n - 1] : "",
        i = n + 1 < e.length ? e[n + 1] : "",
        a = o && !/\s/u.test(o) ? " " : "",
        c = i && !/\s/u.test(i) ? " " : "";
      return `${e.slice(0, n)}${a}~>${c}${e.slice(n + 1)}`;
    }
  }
}
function Mv(e) {
  let t;
  for (let n = 0; n < e.length; n += 1) {
    let r = e[n];
    if (r === "\\" && t !== "single") {
      n += 1;
      continue;
    }
    if (t === "single") {
      r === "'" && (t = void 0);
      continue;
    }
    if (t === "double") {
      r === '"' && (t = void 0);
      continue;
    }
    if (r === "'") {
      t = "single";
      continue;
    }
    if (r === '"') {
      t = "double";
      continue;
    }
    if (r === ";") {
      let i = Av(e);
      return {
        reason:
          "cue_exec received bash ';' syntax. Use cue-shell '->' or '~>' between jobs, or make separate cue_exec calls.",
        ...(i === void 0 ? {} : { suggestion: i }),
      };
    }
    if (r === "<")
      return {
        reason:
          "cue_exec received shell redirection '<'. cue-shell is direct-exec; pass input through a file tool or a supported command argument instead.",
      };
    if (r === ">" && e[n - 1] !== "|" && e[n - 1] !== "-" && e[n - 1] !== "~")
      return {
        reason:
          "cue_exec received shell redirection '>'. cue-shell is direct-exec; inspect stderr with the returned job output instead of redirecting it.",
      };
    if (r !== "|") continue;
    if (e[n + 1] === ">") {
      n += 1;
      continue;
    }
    if (e[n + 1] === "&" && e[n + 2] === ">") {
      n += 2;
      continue;
    }
    if (e[n + 1] === "?" && e[n + 2] === "|") {
      n += 2;
      continue;
    }
    if (e[n + 1] === "|") {
      for (; e[n + 1] === "|";) n += 1;
      continue;
    }
    let o = Pv(e);
    return {
      reason:
        "cue_exec received a bare bash pipe '|'. Use cue-shell '|>' for stdout piping, or use separate cue_exec/file-tool calls.",
      ...(o === void 0 ? {} : { suggestion: o }),
    };
  }
}
function Kn(e, t) {
  if (typeof e != "string" || !e.trim()) throw new Error(`${t} must be a non-empty string`);
  return e;
}
function Kt(e, t) {
  if (e == null) return;
  if (typeof e != "string") throw new Error(t + " must be a string when provided");
  return e.trim() || void 0;
}
var jv = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ox(e, t) {
  let n = Kn(e, t);
  if (!jv.test(n)) throw new Error(`${t} must be a valid environment variable name`);
  return n;
}
function Lv(e, t) {
  if (typeof e != "string") throw new Error(`${t} must be a string`);
  if (/\s/u.test(e))
    throw new Error(
      `${t} cannot contain whitespace because cue-shell :env set uses KEY=VALUE words`,
    );
  return e;
}
function ix(e, t) {
  let n = Kn(e, t);
  if (/\s/u.test(n))
    throw new Error(
      `${t} cannot contain whitespace because cue-shell session commands use word tokens`,
    );
  return n;
}
function Za(e, t) {
  let n = `${t}=`;
  return e
    .split(/\r?\n/u)
    .find((o) => o.startsWith(n))
    ?.slice(n.length);
}
function sx(e) {
  return e.split(/\r?\n/u).map((t) => {
    let n = t.indexOf("=");
    if (n <= 0) return t;
    let r = t.slice(0, n);
    return qa(r) ? `${r}=<redacted>` : t;
  }).join(`
`);
}
function Nv(e, t = "needs") {
  if (e == null) return;
  if (typeof e != "object" || Array.isArray(e))
    throw new Error(`${t} must be an object mapping resource keys to quantities`);
  let n = {};
  for (let [r, o] of Object.entries(e)) {
    let i = r.trim();
    if (!i) throw new Error(`${t} keys must be non-empty`);
    if (i.startsWith("need.")) throw new Error(`${t} keys must omit the need. prefix`);
    if (!dv.test(i)) throw new Error(`${t}.${i} may contain only letters, numbers, _, ., :, and -`);
    if (typeof o == "number") {
      if (!Number.isFinite(o) || !Number.isInteger(o) || o < 0)
        throw new Error(`${t}.${i} must be a non-negative integer count or string quantity`);
      n[i] = o;
      continue;
    }
    if (typeof o != "string" || !o.trim())
      throw new Error(`${t}.${i} must be a non-empty string or non-negative integer`);
    n[i] = o.trim();
  }
  return Object.keys(n).length > 0 ? n : void 0;
}
function ax(e) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(e) ? e : JSON.stringify(e);
}
async function ux(e, t) {
  let n = t.inlineScript !== void 0,
    r = Dv({ venv: t.venv, scriptMode: !0 }),
    o = n ? "-" : (t.path ?? ""),
    i = [...r.argv, o].map(ax).join(" "),
    a = n ? `${["printf", "%s", t.inlineScript ?? ""].map(ax).join(" ")} |> ${i}` : i,
    c = await e.runJob(a, {
      timeout: t.timeout,
      cwd: t.cwd,
      signal: t.signal,
      operation: t.operation,
    }),
    m = xn(c.stdout),
    p = br(c.stderr, m),
    d = [`Script job ${c.jobId}: ${c.status}`];
  if (
    (c.exitCode !== null && (d[0] += ` (exit ${c.exitCode})`),
    c.timedOut &&
      ((d[0] += ` \u2014 timed out after ${t.timeout}s`),
      d.push("", `Track with cue_jobs action=status/wait using id ${c.jobId}.`)),
    m.trim())
  ) {
    let x = Ge(m, t.tailBytes);
    (d.push("", x.text.trimEnd()),
      (x.truncated || c.stdoutTruncated) && d.push(hn("stdout", c.jobId)));
  }
  if (p.trim()) {
    let x = Ge(p, t.tailBytes);
    (d.push("", "[stderr]", x.text.trimEnd()),
      (x.truncated || c.stderrTruncated) && d.push(hn("stderr", c.jobId)));
  }
  let g = {
    language: "python",
    path: t.path ?? t.pathLabel ?? "<inline>",
    inline: t.inlineScript !== void 0,
    jobId: c.jobId,
    status: c.status,
    exitCode: c.exitCode,
    timedOut: c.timedOut,
    warnings: c.warnings,
    stdout: m,
    stderr: p,
    stdoutEncoding: c.stdoutEncoding,
    stderrEncoding: c.stderrEncoding,
    stdoutTruncated: c.stdoutTruncated,
    stderrTruncated: c.stderrTruncated,
    ...(c.stdoutBase64 ? { stdoutBase64: c.stdoutBase64 } : {}),
    ...(c.stderrBase64 ? { stderrBase64: c.stderrBase64 } : {}),
    pythonRunner: r,
    resolvedScriptPath: o,
    ...(r.python ? { pythonInterpreter: r.python } : {}),
    ...(t.venv ? { venv: t.venv } : {}),
  };
  if (c.status === "Failed" && !c.timedOut) {
    let x = new Error(
      d.join(`
`),
    );
    throw ((x.details = g), x);
  }
  return {
    content: [
      {
        type: "text",
        text: d.join(`
`),
      },
    ],
    details: g,
  };
}
function Dv(e = {}) {
  if (e.venv) {
    let t = `${e.venv.replace(/\/+$/u, "")}/bin/python`;
    return {
      executable: "uv",
      source: "uv",
      argv: e.scriptMode
        ? ["uv", "run", "--python", t, "--script"]
        : ["uv", "run", "--python", t, "python"],
      python: { executable: t, source: "venv", version: Fv(t) },
      note: e.scriptMode
        ? "Python scripts are executed through `uv run --python <venv>/bin/python --script <path>` or `uv run --python <venv>/bin/python --script -`."
        : "Python is executed through `uv run --python <venv>/bin/python python ...`.",
    };
  }
  return e.scriptMode
    ? {
        executable: "uv",
        source: "uv",
        argv: ["uv", "run", "--script"],
        note: "Python scripts are executed through `uv run --script <path>` or `uv run --script -`; inline scripts are piped through stdin.",
      }
    : {
        executable: "uv",
        source: "uv",
        argv: ["uv", "run", "python"],
        note: "Python is executed through `uv run python ...`; uv resolves the project/session Python environment.",
      };
}
function Fv(e) {
  try {
    return (
      av(e, ["--version"], {
        encoding: "utf8",
        timeout: 1e3,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() || void 0
    );
  } catch (t) {
    console.debug(`[spark-cue] python --version failed for ${e}`, t);
    return;
  }
}
function cx(e, t, n, r) {
  if (t in e && e[t] !== void 0 && e[t] !== null)
    throw new Error(
      `${r} ${t} is not supported; use ${n}. ${r} ${t} is no longer supported; use ${n}`,
    );
}
function hn(e, t) {
  return `[${e} truncated \u2014 use cue_jobs action=status id=${t} with a larger bounded tail_bytes value]`;
}
function qv(e, t) {
  if (t <= 0) throw new Error("history line limit must be a positive integer");
  let n = e.split(/\r?\n/);
  return n.length <= t
    ? { text: e, truncated: !1 }
    : {
        text: n.slice(Math.max(0, n.length - t)).join(`
`),
        truncated: !0,
      };
}
var ru = 80,
  Uv = 120,
  mx = 60,
  bo = 40,
  Kv = 5,
  Bv = 240;
function Bt(e, t, n) {
  let r = n.fg?.("toolTitle", n.bold?.(`${e} `) ?? `${e} `) ?? `${e} `,
    o = t.filter((a) => !!a),
    i = n.fg?.("muted", o.join(" ")) ?? o.join(" ");
  return new gr(`${r}${i}`.trimEnd());
}
function Ce(e, t = {}) {
  let n = typeof e == "string" && e.trim() ? e.trim() : t.fallback;
  if (!n) return;
  let r = zv(n) ? JSON.stringify(n) : n;
  return `${t.prefix ?? ""}${lx(r, t.maxLength ?? ru)}`;
}
function Jv(e) {
  if (typeof e != "string" || !e.trim()) return [];
  let t = e
      .split(/\r?\n/)
      .map((o) => o.trimEnd())
      .filter((o) => o.trim()),
    n = `inline=${t.length}line(s)`,
    r = t.slice(0, Kv).join(" \u21B5 ");
  return [n, Ce(r, { prefix: "preview=", maxLength: Bv })].filter((o) => !!o);
}
function Ke(e, t = {}) {
  if (!(typeof e != "number" || !Number.isFinite(e)))
    return `${t.prefix ?? ""}${e}${t.suffix ?? ""}`;
}
function Gv(e) {
  if (!e || typeof e != "object" || Array.isArray(e)) return;
  let t = Object.entries(e);
  if (t.length === 0) return;
  let n = t
    .sort(([r], [o]) => r.localeCompare(o))
    .map(([r, o]) => `${r}=${String(o)}`)
    .join(",");
  return `needs=${lx(n, ru)}`;
}
function zv(e) {
  return /\s|["'`]/.test(e);
}
function lx(e, t) {
  let n = e.replaceAll(/\s+/g, " ");
  return n.length <= t ? n : `${n.slice(0, Math.max(0, t - 1))}\u2026`;
}
function fx(e) {
  let t = Symbol("spark-cue-extension");
  Et(e, {
    name: "cue_exec",
    label: "Run Command",
    policy: Ut,
    resolvePolicy: Iv,
    description:
      "Execute a command in cue-shell using the active cue-client transport profile (Unix socket or SSH gateway). SSH profiles connect through the configured remote `cued gateway --stdio`; spark-cue does not auto-start remote daemons. cue-shell is direct-exec (execvp), not bash: do not use shell-only syntax such as semicolon command lists, redirection, or subshell tests. Its composition operators are: |> pipes stdout within one job, &&/|| are job-internal logical operators, -> runs jobs serially on success, ~> runs serially ignoring failure, ||| runs jobs in parallel, and |?| races jobs until one succeeds. Prefer direct-exec commands and Pi file tools; do not use shell wrappers for shell-only syntax. Use Spark grep/find tools for repository search; do not rely on environment wrappers such as rtk to translate find/rg flags. Set background=true to start without waiting; track with cue_jobs action=status/wait, stop with cue_jobs action=stop. Foreground timeout is a wait budget: expiry detaches and leaves the job running. For resource-gated jobs, pass needs={ gpu: 1, gpu_mem: '24GiB' } instead of embedding :run(need...) in command. Runs without a PTY by default; set pty=true only for commands that genuinely need terminal semantics. File-system commands (mv, cp, rm, ls, cat, find, ...) get a short 10s timeout by default.",
    parameters: C.Object({
      command: C.String({
        description:
          "Command to execute in cue-shell, not bash. Use cue operators: '|>' for an in-job pipe, '&&'/'||' for job-internal logical operators, '->' for serial-on-success jobs, '~>' for serial ignoring failure, '|||' for parallel jobs, and '|?|' for any-success race jobs. Prefer separate tool calls/Pi file tools over shell wrappers. Examples: 'cargo build |> grep error -> cargo test', '(cargo build ||| cargo audit) -> cargo test'.",
      }),
      background: C.Optional(
        C.Boolean({
          description: "If true, start and return immediately with job ID. Default: false.",
          default: !1,
        }),
      ),
      timeout: C.Optional(
        C.Number({
          description:
            "Foreground wait budget in seconds. Default: 300 (or 10 for file ops). Ignored when background=true. On expiry the tool detaches; the job keeps running.",
          default: 300,
        }),
      ),
      cwd: C.Optional(
        C.String({
          description:
            "Working directory for the daemon-side job. Defaults to the current Pi session working directory; with SSH profiles this must be valid on the remote host.",
        }),
      ),
      pty: C.Optional(
        C.Boolean({
          description:
            "Whether to allocate a PTY. Default: false for non-interactive tool runs; use true only when a command genuinely needs terminal semantics.",
          default: !1,
        }),
      ),
      needs: C.Optional(
        C.Record(C.String(), C.Union([C.String(), C.Number()]), {
          description:
            "Resource requirements to reserve before spawn, encoded as cue-shell mode params need.<key>=<quantity>. Examples: { gpu: 1, gpu_mem: '24GiB' } or { license: 1 }. Keys omit the need. prefix.",
        }),
      ),
      tail_bytes: C.Optional(
        C.Number({
          description:
            "Limit stdout/stderr to the last N bytes per stream. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(o, i) {
      return Bt(
        "cue_exec",
        [
          Ce(o.command, { maxLength: Uv }),
          o.background === !0 ? "background" : void 0,
          Ke(o.timeout, { prefix: "timeout=", suffix: "s" }),
          Ce(o.cwd, { prefix: "cwd=" }),
          o.pty === !0 ? "pty=true" : void 0,
          Gv(o.needs),
          Ke(o.tail_bytes, { prefix: "tail=" }),
        ],
        i,
      );
    },
    async execute(o, i, a, c, m) {
      cx(i, "tail", "tail_bytes", "cue_exec");
      let p = Kn(i.command, "cue_exec command"),
        d = Mv(p);
      if (d)
        throw new Error(
          d.suggestion === void 0
            ? d.reason
            : `${d.reason}
Try: ${d.suggestion}`,
        );
      let g = Qa(i.background, !1, "cue_exec background"),
        x = Qa(i.pty, !1, "cue_exec pty"),
        I = Kt(i.cwd, "cue_exec cwd"),
        T = gn(i.tail_bytes, wt, "cue_exec tail_bytes"),
        $ = Nv(i.needs, "cue_exec needs"),
        y = xr(i.timeout, bv(p) ? cv : 300, "cue_exec timeout");
      a.throwIfAborted();
      let h = await yo(I, m),
        E = h.cwd,
        v = h.ctx;
      if (g) {
        let K = tt(v, o, "cue_exec/background"),
          q = await rt(
            v,
            t,
            K,
            (ze) => ze.startJob(p, { cwd: E, pty: x, needs: $, operation: K }),
            nt(a, c),
          ),
          se = [];
        if (q.kind === "chain" && q.chain) {
          let ze = q.chain;
          se.push(`Chain: ${ze.id}  |  ${ze.total_jobs} job(s)`);
          for (let Ne of ze.jobs)
            se.push(`  ${Ne.job_id ?? "(pending)"}  [${Ne.status.toLowerCase()}]  ${Ne.pipeline}`);
        } else (se.push(`Job:   ${q.jobId}  [running]`), se.push(`Cmd:   ${q.pipeline ?? p}`));
        se.push(...Xh(q.warnings));
        let Me = q.kind === "chain" && q.chain ? q.chain.id : q.jobId;
        return (
          se.push("", `Track with cue_jobs action=status/wait using id ${Me}.`),
          {
            content: [
              {
                type: "text",
                text: se.join(`
`),
              },
            ],
            details: {
              jobId: q.jobId,
              kind: q.kind,
              chainId: q.chain?.id ?? null,
              chain: q.chain ?? null,
              warnings: q.warnings,
            },
          }
        );
      }
      let O = tt(v, o, "cue_exec/foreground"),
        b = await rt(
          v,
          t,
          O,
          (K, q) =>
            K.runJob(p, {
              timeout: (q.remainingMs ?? y * 1e3) / 1e3,
              cwd: E,
              pty: x,
              needs: $,
              signal: a,
              operation: O,
            }),
          nt(a, c, { deadlineMs: y * 1e3 }),
        );
      if (b.timedOut) {
        let K = xn(b.stdout),
          q = br(b.stderr, K),
          se = [
            `Job ${b.jobId}: Timed out after ${y}s waiting; job remains ${b.status}.`,
            `Track with cue_jobs action=status/wait using id ${b.jobId}.`,
            ...Xh(b.warnings),
          ];
        if (K.trim()) {
          let Me = Ge(K, T);
          (se.push("", "[stdout so far]", Me.text.trimEnd()),
            (Me.truncated || b.stdoutTruncated) && se.push(hn("stdout", b.jobId)));
        }
        if (q.trim()) {
          let Me = Ge(q, T);
          (se.push("", "[stderr so far]", Me.text.trimEnd()),
            (Me.truncated || b.stderrTruncated) && se.push(hn("stderr", b.jobId)));
        }
        return {
          content: [
            {
              type: "text",
              text: se.join(`
`),
            },
          ],
          details: {
            jobId: b.jobId,
            status: b.status,
            timedOut: !0,
            switchedToBackground: !0,
            warnings: b.warnings,
            stdout: K,
            stderr: q,
            stdoutEncoding: b.stdoutEncoding,
            stderrEncoding: b.stderrEncoding,
            stdoutTruncated: b.stdoutTruncated,
            stderrTruncated: b.stderrTruncated,
            ...(b.stdoutBase64 ? { stdoutBase64: b.stdoutBase64 } : {}),
            ...(b.stderrBase64 ? { stderrBase64: b.stderrBase64 } : {}),
          },
        };
      }
      let G = xn(b.stdout),
        L = br(b.stderr, G);
      if (b.status === "Failed" || b.status === "Killed" || b.status === "Cancelled") {
        let K = [`Job ${b.jobId}: ${b.status}`];
        if (
          (b.exitCode !== null && K.push(` (exit ${b.exitCode})`), K.push(Yh(b.warnings)), G.trim())
        ) {
          let se = Ge(G, T);
          (K.push(
            `
` + se.text.trimEnd(),
          ),
            (se.truncated || b.stdoutTruncated) &&
              K.push(`
${hn("stdout", b.jobId)}`));
        }
        if (L.trim()) {
          let se = Ge(L, Math.min(T, 2e3));
          (K.push(
            `
[stderr tail]
` + se.text.trimEnd(),
          ),
            (se.truncated || b.stderrTruncated) &&
              K.push(`
${hn("stderr", b.jobId)}`));
        }
        let q = new Error(K.join(""));
        throw (
          (q.details = {
            jobId: b.jobId,
            status: b.status,
            exitCode: b.exitCode,
            warnings: b.warnings,
            cancelReason: b.cancelReason ?? null,
            stdout: G,
            stderr: L,
            stdoutEncoding: b.stdoutEncoding,
            stderrEncoding: b.stderrEncoding,
            stdoutTruncated: b.stdoutTruncated,
            stderrTruncated: b.stderrTruncated,
            ...(b.stdoutBase64 ? { stdoutBase64: b.stdoutBase64 } : {}),
            ...(b.stderrBase64 ? { stderrBase64: b.stderrBase64 } : {}),
          }),
          q
        );
      }
      let ie = [`Job ${b.jobId}: ${b.status}`];
      if (
        (b.exitCode !== null && b.exitCode !== 0 && ie.push(` (exit ${b.exitCode})`),
        ie.push(Yh(b.warnings)),
        G.trim())
      ) {
        let K = Ge(G, T);
        (ie.push(
          `
` + K.text.trimEnd(),
        ),
          (K.truncated || b.stdoutTruncated) &&
            ie.push(`
${hn("stdout", b.jobId)}`));
      }
      if (L.trim()) {
        let K = Ge(L, T);
        (ie.push(
          `
[stderr]
` + K.text.trimEnd(),
        ),
          (K.truncated || b.stderrTruncated) &&
            ie.push(`
${hn("stderr", b.jobId)}`));
      }
      return {
        content: [{ type: "text", text: ie.join("") }],
        details: {
          jobId: b.jobId,
          status: b.status,
          exitCode: b.exitCode,
          warnings: b.warnings,
          cancelReason: b.cancelReason ?? null,
          stdout: G,
          stderr: L,
          stdoutEncoding: b.stdoutEncoding,
          stderrEncoding: b.stderrEncoding,
          stdoutTruncated: b.stdoutTruncated,
          stderrTruncated: b.stderrTruncated,
          ...(b.stdoutBase64 ? { stdoutBase64: b.stdoutBase64 } : {}),
          ...(b.stderrBase64 ? { stderrBase64: b.stderrBase64 } : {}),
        },
      };
    },
  });
  async function n(o, i) {
    let {
      resolvedPath: a,
      body: c,
      pathLabel: m,
      timeout: p,
      tailBytes: d,
      toolName: g,
      toolCallId: x,
      signal: I,
      onUpdate: T,
    } = o;
    if ((I.throwIfAborted(), !c.trim()))
      throw new Error(`${g} body is empty (cue-shell rejects empty scripts)`);
    let $ = tt(i, x, `${g}/run-script`),
      y = await rt(
        i,
        t,
        $,
        (b, G) =>
          b.runScript({
            path: a,
            input: c,
            timeout: (G.remainingMs ?? p * 1e3) / 1e3,
            signal: I,
            operation: $,
          }),
        nt(I, T, { replaySafe: !0, deadlineMs: p * 1e3 }),
      ),
      h = Cv(y, { pathLabel: m, timeout: p, tailBytes: d }),
      E = y.items.map((b) => ({
        index: b.index,
        source: b.source,
        kind: b.kind,
        jobIds: b.jobIds,
        chainId: b.chainId,
        cronId: b.cronId,
        status: b.status,
        exitCode: b.exitCode,
      })),
      v = {
        content: [
          {
            type: "text",
            text: h.join(`
`),
          },
        ],
      },
      O = {
        scriptId: y.scriptId,
        source: y.source,
        status: y.status,
        exitCode: y.exitCode,
        failedItemIndex: y.failedItemIndex,
        timedOut: y.timedOut,
        items: E,
      };
    if (y.status === "failed" && !y.timedOut) {
      let b = new Error(
        h.join(`
`),
      );
      throw ((b.details = O), b);
    }
    return { ...v, details: O };
  }
  (Et(e, {
    name: "cue_run",
    label: "Run Cue File",
    policy: Ut,
    description:
      "Run a .cue file in cue-shell, mirroring `cue run <file.cue>`. Top-level items execute sequentially with fail-fast semantics inside a fresh isolated scope forked from HEAD. Each item may use cue-shell composition operators (`|>`, `&&`, `||`, `->`, `~>`, `|||`, `|?|`) but must not use bash-shell syntax (`;`, redirection). For inline bodies (no file on disk) use cue_script instead. Foreground only: blocks until ScriptFinished or `timeout` seconds elapse; timeout detaches and leaves the script running.",
    parameters: C.Object({
      path: C.String({
        description:
          "Path to a .cue file to run. Required. Resolved against the current Pi session working directory when relative.",
      }),
      timeout: C.Optional(
        C.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On expiry the tool detaches; the script keeps running.",
          default: 300,
        }),
      ),
      tail_bytes: C.Optional(
        C.Number({
          description:
            "Limit per-item stdout/stderr to the last N bytes when rendering the aggregated transcript. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(o, i) {
      return Bt(
        "cue_run",
        [
          Ce(o.path, { prefix: "path=", maxLength: mx }),
          Ke(o.timeout, { prefix: "timeout=", suffix: "s" }),
          Ke(o.tail_bytes, { prefix: "tail=" }),
        ],
        i,
      );
    },
    async execute(o, i, a, c, m) {
      let p = Kn(i.path, "cue_run path"),
        d = xr(i.timeout, 300, "cue_run timeout"),
        g = gn(i.tail_bytes, wt, "cue_run tail_bytes"),
        x = Zi(void 0, m.cwd),
        { isAbsolute: I, resolve: T } = await import("node:path"),
        $ = I(p) ? p : T(x, p);
      if (!$.endsWith(".cue")) throw new Error(`cue_run path must end in .cue (got ${$})`);
      let { readFile: y } = await import("node:fs/promises"),
        h;
      try {
        h = await y($, "utf-8");
      } catch (v) {
        throw new Error(`cue_run failed to read ${$}: ${v.message}`);
      }
      let E = await yo(void 0, m);
      return n(
        {
          resolvedPath: $,
          body: h,
          pathLabel: $,
          timeout: d,
          tailBytes: g,
          toolName: "cue_run",
          toolCallId: o,
          signal: a,
          onUpdate: c,
        },
        E.ctx,
      );
    },
  }),
    Et(e, {
      name: "cue_script",
      label: "Run Cue Script",
      policy: Ut,
      description:
        "Run an inline .cue script body in cue-shell. Top-level items execute sequentially with fail-fast semantics inside a fresh isolated scope forked from HEAD. Each item may use cue-shell composition operators (`|>`, `&&`, `||`, `->`, `~>`, `|||`, `|?|`) but must not use bash-shell syntax (`;`, redirection). If you have a real .cue file on disk, prefer cue_run. Optionally provide `pathLabel` to label the inline script in TUI history. Foreground only: blocks until ScriptFinished or `timeout` seconds elapse; timeout detaches and leaves the script running.",
      parameters: C.Object({
        script: C.String({
          description:
            "Inline .cue script body. Required. The script is sent to the daemon as if it were a file at `pathLabel` (defaults to `<inline>`).",
        }),
        pathLabel: C.Optional(
          C.String({ description: "Display label for inline scripts. Default: `<inline>`." }),
        ),
        timeout: C.Optional(
          C.Number({
            description:
              "Foreground wait budget in seconds. Default: 300. On expiry the tool detaches; the script keeps running.",
            default: 300,
          }),
        ),
        tail_bytes: C.Optional(
          C.Number({
            description:
              "Limit per-item stdout/stderr to the last N bytes when rendering the aggregated transcript. Default: 16384. Must be positive.",
          }),
        ),
      }),
      renderCall(o, i) {
        let a =
          typeof o.script == "string" && o.script.trim()
            ? `inline=${o.script.split(/\r?\n/).filter((c) => c.trim()).length}line(s)`
            : void 0;
        return Bt(
          "cue_script",
          [
            a,
            Ce(o.pathLabel, { prefix: "label=", maxLength: bo }),
            Ke(o.timeout, { prefix: "timeout=", suffix: "s" }),
            Ke(o.tail_bytes, { prefix: "tail=" }),
          ],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        let p = Kn(i.script, "cue_script script"),
          d = Kt(i.pathLabel, "cue_script pathLabel") ?? "<inline>",
          g = xr(i.timeout, 300, "cue_script timeout"),
          x = gn(i.tail_bytes, wt, "cue_script tail_bytes"),
          I = await yo(void 0, m);
        return n(
          {
            resolvedPath: d,
            body: p,
            pathLabel: d,
            timeout: g,
            tailBytes: x,
            toolName: "cue_script",
            toolCallId: o,
            signal: a,
            onUpdate: c,
          },
          I.ctx,
        );
      },
    }),
    Et(e, {
      name: "script_run",
      label: "Run Script File",
      policy: Ut,
      description:
        "Run a script file with an explicit language runner. Supported languages in this version: cue-shell and python. For cue-shell this delegates to RunScript and mirrors cue_run; for python it executes through uv run --script <path>, optionally with --python <venv>/bin/python, and reports the resolved runner in details.",
      parameters: C.Object({
        path: C.String({ description: "Path to the script file to run." }),
        language: C.String({ description: "Script language. Required: cue-shell or python." }),
        timeout: C.Optional(
          C.Number({
            description: "Foreground wait budget in seconds. Default: 300.",
            default: 300,
          }),
        ),
        tail_bytes: C.Optional(
          C.Number({
            description:
              "Limit stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
          }),
        ),
        venv: C.Optional(
          C.String({ description: "Python virtualenv path. Only valid for language=python." }),
        ),
      }),
      renderCall(o, i) {
        return Bt(
          "script_run",
          [
            Ce(o.language, { prefix: "lang=" }),
            Ce(o.path, { prefix: "path=", maxLength: mx }),
            Ke(o.timeout, { prefix: "timeout=", suffix: "s" }),
            Ke(o.tail_bytes, { prefix: "tail=" }),
            Ce(o.venv, { prefix: "venv=", maxLength: bo }),
          ],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        let p = fn(i.language, void 0, Wh, "script_run language"),
          d = Kn(i.path, "script_run path"),
          g = xr(i.timeout, 300, "script_run timeout"),
          x = gn(i.tail_bytes, wt, "script_run tail_bytes"),
          I = Kt(i.venv, "script_run venv");
        if (p !== "python" && I)
          throw new Error("script_run venv is only supported for language=python");
        let T = await yo(void 0, m),
          $ = Zi(void 0, m.cwd),
          y = p === "cue-shell" ? $ : T.cwd,
          { isAbsolute: h, resolve: E } = await import("node:path"),
          v = h(d) ? d : E(y, d),
          O = I ? (h(I) ? I : E(y, I)) : void 0;
        if (p === "cue-shell") {
          if (!v.endsWith(".cue"))
            throw new Error(`script_run language=cue-shell path must end in .cue (got ${v})`);
          let { readFile: G } = await import("node:fs/promises"),
            L;
          try {
            L = await G(v, "utf-8");
          } catch (ie) {
            throw new Error(`script_run failed to read ${v}: ${ie.message}`);
          }
          return n(
            {
              resolvedPath: v,
              body: L,
              pathLabel: v,
              timeout: g,
              tailBytes: x,
              toolName: "script_run",
              toolCallId: o,
              signal: a,
              onUpdate: c,
            },
            T.ctx,
          );
        }
        let b = tt(T.ctx, o, "script_run/python");
        return rt(
          T.ctx,
          t,
          b,
          (G, L) =>
            ux(G, {
              path: v,
              timeout: (L.remainingMs ?? g * 1e3) / 1e3,
              tailBytes: x,
              cwd: y,
              venv: O,
              signal: a,
              operation: b,
            }),
          nt(a, c, { deadlineMs: g * 1e3 }),
        );
      },
    }),
    Et(e, {
      name: "script_eval",
      label: "Evaluate Script",
      policy: Ut,
      description:
        "Run an inline script body with an explicit language runner. Supported languages in this version: cue-shell and python. Inline Python is piped to uv run --script - through cue-shell, optionally with --python <venv>/bin/python, and reports the resolved runner in details. Manual cue_exec python calls are blocked by the default daemon guardrails.",
      parameters: C.Object({
        script: C.String({ description: "Inline script body to run." }),
        language: C.String({ description: "Script language. Required: cue-shell or python." }),
        pathLabel: C.Optional(
          C.String({ description: "Display label for inline scripts. Default: <inline>." }),
        ),
        timeout: C.Optional(
          C.Number({
            description: "Foreground wait budget in seconds. Default: 300.",
            default: 300,
          }),
        ),
        tail_bytes: C.Optional(
          C.Number({
            description:
              "Limit stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
          }),
        ),
        venv: C.Optional(
          C.String({ description: "Python virtualenv path. Only valid for language=python." }),
        ),
      }),
      renderCall(o, i) {
        return Bt(
          "script_eval",
          [
            Ce(o.language, { prefix: "lang=" }),
            ...Jv(o.script),
            Ce(o.pathLabel, { prefix: "label=", maxLength: bo }),
            Ke(o.timeout, { prefix: "timeout=", suffix: "s" }),
            Ke(o.tail_bytes, { prefix: "tail=" }),
            Ce(o.venv, { prefix: "venv=", maxLength: bo }),
          ],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        let p = fn(i.language, void 0, Wh, "script_eval language"),
          d = Kn(i.script, "script_eval script"),
          g = Kt(i.pathLabel, "script_eval pathLabel") ?? "<inline>",
          x = xr(i.timeout, 300, "script_eval timeout"),
          I = gn(i.tail_bytes, wt, "script_eval tail_bytes"),
          T = Kt(i.venv, "script_eval venv");
        if (p !== "python" && T)
          throw new Error("script_eval venv is only supported for language=python");
        let $ = await yo(void 0, m),
          y = $.cwd,
          { isAbsolute: h, resolve: E } = await import("node:path"),
          v = T ? (h(T) ? T : E(y, T)) : void 0;
        if (p === "cue-shell")
          return n(
            {
              resolvedPath: g,
              body: d,
              pathLabel: g,
              timeout: x,
              tailBytes: I,
              toolName: "script_eval",
              toolCallId: o,
              signal: a,
              onUpdate: c,
            },
            $.ctx,
          );
        let O = tt($.ctx, o, "script_eval/python");
        return rt(
          $.ctx,
          t,
          O,
          (b, G) =>
            ux(b, {
              inlineScript: d,
              pathLabel: g,
              timeout: (G.remainingMs ?? x * 1e3) / 1e3,
              tailBytes: I,
              cwd: y,
              venv: v,
              signal: a,
              operation: O,
            }),
          nt(a, c, { deadlineMs: x * 1e3 }),
        );
      },
    }),
    Et(e, {
      name: "cue_jobs",
      label: "Cue Jobs",
      policy: Th,
      description:
        "Manage cue-shell jobs. action='list' lists jobs, action='status' inspects a job, chain, or cron, action='wait' waits for a job or chain, and action='stop' stops a job or removes a cron.",
      parameters: C.Object({
        action: C.Optional(
          C.String({ description: "Action: list, status, wait, stop. Default: list." }),
        ),
        id: C.Optional(
          C.String({
            description:
              "Target ID: job J<n>; chain CH<n> for status/wait; cron C<n> for status/stop.",
          }),
        ),
        status: C.Optional(
          C.String({
            description:
              "Filter for action='list': running, pending, done, failed, killed, all. Default: all.",
          }),
        ),
        limit: C.Optional(
          C.Number({ description: "Maximum jobs to show for action='list'. Default: 20." }),
        ),
        timeout: C.Optional(
          C.Number({ description: "Max wait time in seconds for action='wait'. Default: 300." }),
        ),
        tail_bytes: C.Optional(
          C.Number({
            description:
              "Limit stdout/stderr to the last N bytes for action='status' or action='wait'. Default: 16384. Must be positive.",
          }),
        ),
      }),
      renderCall(o, i) {
        return Bt(
          "cue_jobs",
          [
            Ce(o.action, { prefix: "action=", fallback: "list" }),
            Ce(o.id, { prefix: "id=" }),
            Ce(o.status, { prefix: "status=" }),
            Ke(o.limit, { prefix: "limit=" }),
            Ke(o.timeout, { prefix: "timeout=", suffix: "s" }),
            Ke(o.tail_bytes, { prefix: "tail=" }),
          ],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        let p = fn(i.action, "list", mv, "cue_jobs action"),
          d = Kt(i.id, "cue_jobs id"),
          g = fn(i.status, "all", lv, "cue_jobs status"),
          x = Yi(i.limit, Qi, "cue_jobs limit"),
          I = xr(i.timeout, 300, "cue_jobs timeout"),
          T = gn(i.tail_bytes, wt, "cue_jobs tail_bytes"),
          $ = await ln(m, t);
        if (p === "list") {
          let y = await $.listJobs();
          g !== "all" && (y = y.filter((v) => v.status.toLowerCase() === g));
          let h = y.length;
          if (((y = y.slice(0, x)), h === 0))
            return {
              content: [{ type: "text", text: "No matching jobs." }],
              details: { count: 0, shown: 0, jobs: [] },
            };
          let E = y.map(Rv);
          return (
            h > y.length && E.push(`\u2026 ${h - y.length} more job(s)`),
            {
              content: [
                {
                  type: "text",
                  text: E.join(`
`),
                },
              ],
              details: { count: h, shown: y.length, jobs: y },
            }
          );
        }
        if (!d)
          return {
            content: [{ type: "text", text: `action='${p}' requires id parameter.` }],
            details: { error: "missing_id" },
          };
        if (p === "stop") {
          let y = tt(m, o, "cue_jobs/stop");
          return (
            await rt(m, t, y, (h) => h.stopJob(d, y), nt(a, c)),
            { content: [{ type: "text", text: `Stopped ${d}.` }], details: { targetId: d } }
          );
        }
        if (p === "status") {
          if (d.startsWith("CH")) {
            let E = Zh(await $.listJobs(), d);
            return E.length === 0
              ? { content: [{ type: "text", text: `${d} not found.` }], details: { found: !1 } }
              : {
                  content: [
                    {
                      type: "text",
                      text: (await tx($, d, E, T)).join(`
`),
                    },
                  ],
                  details: { chainId: d, status: tu(E), jobs: E },
                };
          }
          if (d.startsWith("C")) {
            let E = await $.cronStatus(d);
            return E
              ? {
                  content: [
                    {
                      type: "text",
                      text: `\u23F0 ${E.id}  [${E.status}]  ${E.schedule} \u2192 ${E.command}`,
                    },
                  ],
                  details: {
                    cronId: E.id,
                    status: E.status,
                    schedule: E.schedule,
                    command: E.command,
                  },
                }
              : { content: [{ type: "text", text: `${d} not found.` }], details: { found: !1 } };
          }
          let y = await $.jobStatus(d);
          if (!y)
            return { content: [{ type: "text", text: `${d} not found.` }], details: { found: !1 } };
          let h = [`${yr(y.status)} \u2014 ${y.pipeline}`];
          return (
            y.exit_code != null && h.push(`Exit code: ${y.exit_code}`),
            nu(y, h),
            y.chain_id &&
              h.push(
                `Chain: ${y.chain_id} (leaf ${(y.chain_index ?? 0) + 1}/${y.chain_total ?? "?"})`,
              ),
            await ex($, y, h, T),
            {
              content: [
                {
                  type: "text",
                  text: h.join(`
`),
                },
              ],
              details: {
                jobId: y.id,
                status: y.status,
                exitCode: y.exit_code,
                pipeline: y.pipeline,
                pendingReason: Io(y) ?? null,
              },
            }
          );
        }
        if (p === "wait") {
          let y = Date.now() + I * 1e3;
          if (d.startsWith("CH")) {
            for (; Date.now() < y;) {
              let h = Zh(await $.listJobs(), d);
              if (h.length === 0)
                return {
                  content: [{ type: "text", text: `Chain ${d} not found.` }],
                  details: { found: !1 },
                };
              let E = Math.max(...h.map((O) => O.chain_total ?? h.length)),
                v = h.some((O) => O.status !== "Done" && eu(O.status));
              if ((h.length >= E || v) && h.every((O) => eu(O.status))) {
                let O = tu(h),
                  b = await tx($, d, h, T),
                  G = `Chain ${d} completed

${b.join(`
`)}`;
                return (
                  (O === "Failed" || O === "Killed" || O === "Cancelled") &&
                    Qh(O === "Failed" ? G : `Chain ${d} was ${O.toLowerCase()}`, {
                      chainId: d,
                      status: O,
                      jobs: h,
                    }),
                  {
                    content: [{ type: "text", text: G }],
                    details: { chainId: d, status: O, jobs: h },
                  }
                );
              }
              await new Promise((O) => setTimeout(O, 500));
            }
            return {
              content: [{ type: "text", text: `Timed out after ${I}s waiting for ${d}.` }],
              details: { timedOut: !0, targetId: d },
            };
          }
          for (; Date.now() < y;) {
            let h = await $.jobStatus(d);
            if (!h)
              return {
                content: [{ type: "text", text: `Job ${d} not found.` }],
                details: { found: !1 },
              };
            if (
              h.status === "Done" ||
              h.status === "Failed" ||
              h.status === "Killed" ||
              h.status === "Cancelled"
            ) {
              let E = [`${yr(h.status)} \u2014 ${h.pipeline}`];
              (h.exit_code != null && E.push(`Exit code: ${h.exit_code}`),
                nu(h, E),
                await ex($, h, E, T));
              let v = `Job ${d} completed

${E.join(`
`)}`;
              return (
                (h.status === "Failed" || h.status === "Killed" || h.status === "Cancelled") &&
                  Qh(h.status === "Failed" ? v : `Job ${d} was ${h.status.toLowerCase()}`, {
                    jobId: h.id,
                    status: h.status,
                    exitCode: h.exit_code,
                    pendingReason: Io(h) ?? null,
                  }),
                {
                  content: [{ type: "text", text: v }],
                  details: {
                    jobId: h.id,
                    status: h.status,
                    exitCode: h.exit_code,
                    pendingReason: Io(h) ?? null,
                  },
                }
              );
            }
            await new Promise((E) => setTimeout(E, 500));
          }
          return {
            content: [{ type: "text", text: `Timed out after ${I}s waiting for ${d}.` }],
            details: { timedOut: !0 },
          };
        }
        throw new Error("Unhandled cue_jobs action");
      },
    }),
    Et(e, {
      name: "cue_resources",
      label: "Cue Resources",
      policy: vh,
      description:
        "Inspect cue-shell resource scheduling state. action='providers' lists registered providers, routed resource keys, and active reservations; action='resources' shows current provider snapshots/units when providers support probing.",
      parameters: C.Object({
        action: C.Optional(
          C.String({ description: "Action: providers or resources. Default: providers." }),
        ),
      }),
      renderCall(o, i) {
        return Bt("cue_resources", [Ce(o.action, { prefix: "action=", fallback: "providers" })], i);
      },
      async execute(o, i, a, c, m) {
        let p = fn(i.action, "providers", pv, "cue_resources action"),
          d = await ln(m, t),
          g = p === "providers" ? ":providers" : ":resources",
          x = await d.evalText(g),
          I = r(x);
        return {
          content: [
            {
              type: "text",
              text: I
                ? `${x.trimEnd()}

${I}`
                : x,
            },
          ],
          details: { action: p, command: g, ...(I ? { hint: I } : {}) },
        };
      },
    }));
  function r(o) {
    let i = o.trim().toLowerCase();
    if (
      !i ||
      /no .*resource .*providers|no .*providers|providers:\s*0|registered providers:\s*0/u.test(i)
    )
      return [
        "Hint: no cue-shell resource provider is registered for this session.",
        '  next: run cue_resources({ action: "providers" }) to confirm provider routing, remove needs={...} from cue_exec when no gated resource is required, or start/register a cue-shell resource provider for keys such as gpu/gpu_mem before submitting resource-gated jobs.',
      ].join(`
`);
  }
  return (
    Et(e, {
      name: "cue_schedule",
      label: "Cue Schedule",
      policy: Sh,
      description:
        "Manage scheduled cue-shell jobs. action='add': schedule a recurring or one-shot job (requires schedule + command). action='list': list schedules. action='pause'/'resume': control a schedule by id. action='remove': delete a schedule by id (also available via cue_jobs action=stop).",
      parameters: C.Object({
        action: C.String({ description: "Action: add, list, pause, resume, remove." }),
        schedule: C.Optional(
          C.String({
            description:
              "Schedule (required for action='add'). Examples: 'every 5m', 'at 14:30', 'in 30s', 'daily', 'hourly', or raw cron '*/5 * * * *'.",
          }),
        ),
        command: C.Optional(
          C.String({ description: "Command to run on schedule (required for action='add')." }),
        ),
        id: C.Optional(
          C.String({ description: "Schedule/cron ID (C<n>), required for pause/resume/remove." }),
        ),
        status: C.Optional(
          C.String({
            description:
              "Filter for action='list': scheduled, paused, completed, expired, failed, all. Default: all.",
          }),
        ),
        limit: C.Optional(
          C.Number({ description: "Maximum schedules to show for action=list. Default: 20." }),
        ),
      }),
      renderCall(o, i) {
        return Bt(
          "cue_schedule",
          [
            Ce(o.action, { prefix: "action=", fallback: "list" }),
            Ce(o.id, { prefix: "id=" }),
            Ce(o.schedule, { prefix: "schedule=", maxLength: bo }),
            Ce(o.command, { prefix: "command=", maxLength: ru }),
            Ce(o.status, { prefix: "status=" }),
            Ke(o.limit, { prefix: "limit=" }),
          ],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        let p = fn(i.action, void 0, fv, "cue_schedule action"),
          d = Kt(i.schedule, "cue_schedule schedule"),
          g = Kt(i.command, "cue_schedule command"),
          x = Kt(i.id, "cue_schedule id"),
          I = fn(i.status, "all", gv, "cue_schedule status"),
          T = Yi(i.limit, Qi, "cue_schedule limit"),
          $ = await ln(m, t);
        if (p === "add") {
          if (!d || !g)
            return {
              content: [{ type: "text", text: "action='add' requires schedule and command." }],
              details: {},
            };
          let y = tt(m, o, "cue_schedule/add"),
            h = await rt(m, t, y, (E) => E.addCron(d, g, y), nt(a, c));
          return {
            content: [
              {
                type: "text",
                text: `Schedule: ${h}
Remove with cue_schedule action=remove id=${h}.`,
              },
            ],
            details: { cronId: h, schedule: d, command: g },
          };
        }
        if (p === "list") {
          let y = await $.listCrons();
          I !== "all" && (y = y.filter((v) => v.status.toLowerCase() === I));
          let h = y.length;
          if (((y = y.slice(0, T)), h === 0))
            return {
              content: [{ type: "text", text: "No matching schedules." }],
              details: { count: 0, shown: 0, crons: [] },
            };
          let E = y.map((v) => `${v.id}  [${v.status}]  ${v.schedule}  \u2192  ${v.command}`);
          return (
            h > y.length && E.push(`\u2026 ${h - y.length} more schedule(s)`),
            {
              content: [
                {
                  type: "text",
                  text: E.join(`
`),
                },
              ],
              details: { count: h, shown: y.length, crons: y },
            }
          );
        }
        if (!x)
          return {
            content: [{ type: "text", text: `action='${p}' requires id parameter.` }],
            details: {},
          };
        if (p === "pause") {
          let y = tt(m, o, "cue_schedule/pause");
          return (
            await rt(m, t, y, (h) => h.pauseCron(x, y), nt(a, c)),
            {
              content: [
                {
                  type: "text",
                  text: `Paused ${x}. Resume with cue_schedule action=resume id=${x}.`,
                },
              ],
              details: { id: x, paused: !0 },
            }
          );
        }
        if (p === "resume") {
          let y = tt(m, o, "cue_schedule/resume");
          return (
            await rt(m, t, y, (h) => h.resumeCron(x, y), nt(a, c)),
            { content: [{ type: "text", text: `Resumed ${x}.` }], details: { id: x, resumed: !0 } }
          );
        }
        if (p === "remove") {
          let y = tt(m, o, "cue_schedule/remove");
          return (
            await rt(m, t, y, (h) => h.removeCron(x, y), nt(a, c)),
            { content: [{ type: "text", text: `Removed ${x}.` }], details: { id: x, removed: !0 } }
          );
        }
        throw new Error("Unhandled cue_schedule action");
      },
    }),
    Et(e, {
      name: "cue_scope",
      label: "Cue Scope",
      policy: kh,
      description:
        "Inspect or mutate cue-shell session state. action='list' lists scopes, 'env' shows session env, 'config' shows config, 'env_set' sets KEY=VALUE, 'env_unset' removes KEY, 'path_prepend' prepends PATH, 'cd' changes session cwd, 'refresh' explicitly refreshes the session from host cwd/env, and 'status' shows bounded cwd/PATH status.",
      parameters: C.Object({
        action: C.Optional(
          C.String({
            description:
              "Action: list, env, config, env_set, env_unset, path_prepend, cd, refresh, or status. Default: list.",
          }),
        ),
        limit: C.Optional(
          C.Number({ description: "Maximum scopes to show for action='list'. Default: 20." }),
        ),
        includeEnv: C.Optional(
          C.Boolean({
            description: "For action='list', also include HEAD env output. Default: false.",
          }),
        ),
        tail_bytes: C.Optional(
          C.Number({
            description:
              "For action='env' or action='config', limit output to the last N bytes. Default: 16384. Must be positive.",
          }),
        ),
        key: C.Optional(
          C.String({
            description: "Environment variable name for action='env_set' or 'env_unset'.",
          }),
        ),
        value: C.Optional(
          C.String({ description: "Environment variable value for action='env_set'." }),
        ),
        path: C.Optional(
          C.String({ description: "Path for action='path_prepend' or action='cd'." }),
        ),
      }),
      renderCall(o, i) {
        return Bt(
          "cue_scope",
          [
            Ce(o.action, { prefix: "action=", fallback: "list" }),
            Ke(o.limit, { prefix: "limit=" }),
            o.includeEnv === !0 ? "include-env" : void 0,
            Ke(o.tail_bytes, { prefix: "tail=" }),
            Ce(o.key, { prefix: "key=" }),
            Ce(o.path, { prefix: "path=" }),
          ],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        cx(i, "env_tail_bytes", "tail_bytes", "cue_scope");
        let p = fn(i.action, "list", hv, "cue_scope action"),
          d = Yi(i.limit, Qi, "cue_scope limit"),
          g = Qa(i.includeEnv, !1, "cue_scope includeEnv"),
          x = gn(i.tail_bytes, wt, "cue_scope tail_bytes"),
          I = await ln(m, t);
        if (p === "env_set") {
          let h = ox(i.key, "cue_scope key"),
            E = Lv(i.value, "cue_scope value"),
            v = tt(m, o, "cue_scope/env_set"),
            O = await rt(m, t, v, (b) => b.setEnv({ [h]: E }, v), nt(a, c));
          return {
            content: [
              {
                type: "text",
                text: `Set ${h} for this cue session.
${O.summary}`,
              },
            ],
            details: { action: p, key: h, scope: O },
          };
        }
        if (p === "env_unset") {
          let h = ox(i.key, "cue_scope key"),
            E = tt(m, o, "cue_scope/env_unset"),
            v = await rt(m, t, E, (O) => O.unsetEnv([h], E), nt(a, c));
          return {
            content: [
              {
                type: "text",
                text: `Unset ${h} for this cue session.
${v.summary}`,
              },
            ],
            details: { action: p, key: h, scope: v },
          };
        }
        if (p === "path_prepend") {
          let h = ix(i.path, "cue_scope path"),
            E = await I.showEnv(),
            v = Za(E, "PATH") ?? "",
            O = v ? `${h}:${v}` : h,
            b = tt(m, o, "cue_scope/path_prepend"),
            G = await rt(m, t, b, (L) => L.setEnv({ PATH: O }, b), nt(a, c));
          return {
            content: [
              {
                type: "text",
                text: `Prepended ${h} to PATH for this cue session.
${G.summary}`,
              },
            ],
            details: { action: p, path: h, scope: G },
          };
        }
        if (p === "cd") {
          let h = ix(i.path, "cue_scope path"),
            E = tt(m, o, "cue_scope/cd"),
            v = await rt(m, t, E, (O) => O.changeDirectory(h, E), nt(a, c));
          return {
            content: [
              {
                type: "text",
                text: `Changed cue session cwd.
${v.summary}`,
              },
            ],
            details: { action: p, path: h, scope: v },
          };
        }
        if (p === "refresh") {
          let h = { ...Xi(m), refresh: !0 };
          await I.handshake(h);
          let E = await I.showEnv(),
            v = E.split(/\r?\n/u).find((L) => L.startsWith("cwd=")) ?? "cwd=?",
            O = Za(E, "PATH") ?? "",
            b = Ge(O, Math.min(x, wt)),
            G = ["Refreshed cue session from host cwd/env.", v, `PATH=${b.text}`];
          return (
            b.truncated &&
              G.push(
                "[PATH truncated \u2014 use action=status/env with a larger tail_bytes value]",
              ),
            {
              content: [
                {
                  type: "text",
                  text: G.join(`
`),
                },
              ],
              details: {
                action: p,
                sessionId: h.sessionId,
                cwd: h.cwd,
                envKeys: Object.keys(h.env).length,
                pathChars: O.length,
                shownPathChars: b.text.length,
                truncated: b.truncated,
              },
            }
          );
        }
        if (p === "status") {
          let h = await I.showEnv(),
            E = h.split(/\r?\n/u).find((G) => G.startsWith("cwd=")) ?? "cwd=?",
            v = Za(h, "PATH") ?? "",
            O = Ge(v, Math.min(x, wt)),
            b = [E, `PATH=${O.text}`];
          return (
            O.truncated &&
              b.push(
                "[PATH truncated \u2014 use action=env with a larger bounded tail_bytes value]",
              ),
            {
              content: [
                {
                  type: "text",
                  text: b.join(`
`),
                },
              ],
              details: {
                action: p,
                cwd: E.slice(4),
                pathChars: v.length,
                shownPathChars: O.text.length,
                truncated: O.truncated,
              },
            }
          );
        }
        if (p === "env" || p === "config") {
          let h = p === "env" ? await I.showEnv() : await I.showConfig(),
            E = p === "env" ? sx(h) : h,
            v = Ge(E, x),
            O = [v.text.trimEnd()];
          return (
            v.truncated && O.push(`[${p} truncated \u2014 use a larger bounded tail_bytes value]`),
            {
              content: [
                {
                  type: "text",
                  text: O.join(`
`),
                },
              ],
              details: {
                action: p,
                rawChars: h.length,
                shownChars: v.text.length,
                truncated: v.truncated,
              },
            }
          );
        }
        let T = await I.listScopes(),
          $ = T.slice(0, d);
        if (T.length === 0)
          return {
            content: [{ type: "text", text: "No scopes." }],
            details: { count: 0, shown: 0, scopes: [] },
          };
        let y = $.map(
          (h) => `${h.hash}  parent=${h.parent ?? "-"}  cwd=${h.cwd}  env=${h.env_count}`,
        );
        if ((T.length > $.length && y.push(`\u2026 ${T.length - $.length} more scope(s)`), g)) {
          let h = Ge(sx(await I.showEnv()), x);
          (y.push("", "--- HEAD env ---", h.text.trimEnd()),
            h.truncated &&
              y.push("[HEAD env truncated \u2014 use a larger bounded tail_bytes value]"));
        }
        return {
          content: [
            {
              type: "text",
              text: y.join(`
`),
            },
          ],
          details: { count: T.length, shown: $.length, scopes: $ },
        };
      },
    }),
    Et(e, {
      name: "cue_history",
      label: "Cue History",
      policy: _h,
      description:
        "Show recent cue-shell history. Pass an id to focus on one job/cron. Output is bounded by default.",
      parameters: C.Object({
        id: C.Optional(
          C.String({ description: "Optional job ID (J<n>) or cron ID (C<n>) to focus on." }),
        ),
        limit: C.Optional(
          C.Number({
            description: "Maximum recent history lines to show. Default: 80. Must be positive.",
          }),
        ),
        tail_bytes: C.Optional(
          C.Number({
            description:
              "Limit history text to the last N bytes. Default: 16384. Must be positive.",
          }),
        ),
      }),
      renderCall(o, i) {
        return Bt(
          "cue_history",
          [Ce(o.id), Ke(o.limit, { prefix: "limit=" }), Ke(o.tail_bytes, { prefix: "tail=" })],
          i,
        );
      },
      async execute(o, i, a, c, m) {
        let p = Kt(i.id, "cue_history id"),
          d = Yi(i.limit, 80, "cue_history limit"),
          g = gn(i.tail_bytes, wt, "cue_history tail_bytes"),
          I = await (await ln(m, t)).showLog(p, d, g),
          T = Ge(I, g),
          $ = qv(T.text, d),
          y = [];
        return (
          T.truncated &&
            y.push("[history truncated by bytes \u2014 use a larger bounded tail_bytes value]"),
          $.truncated &&
            y.push("[history truncated by lines \u2014 use a larger bounded limit value]"),
          {
            content: [
              {
                type: "text",
                text: [$.text, ...y].filter(Boolean).join(`
`),
              },
            ],
            details: {
              id: p ?? null,
              rawChars: I.length,
              shownChars: $.text.length,
              truncated: T.truncated || $.truncated,
            },
          }
        );
      },
    }),
    e.on?.("session_start", () => {
      if (!e.getActiveTools || !e.setActiveTools) return;
      let o = e.getActiveTools().filter((i) => i !== "bash");
      e.setActiveTools(o);
    }),
    e.on?.("session_shutdown", (o, i) => {
      Ya(t, i);
    }),
    {
      releaseSession(o) {
        Ya(t, o);
      },
      dispose() {
        zh(t);
      },
    }
  );
}
var Co = [
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
  "cue_resources",
  "cue_schedule",
  "cue_scope",
  "cue_history",
];
function gx(e) {
  return e.map((t) => t.text).join(`
`);
}
function ee(e) {
  return typeof e == "string" ? e : void 0;
}
function Jt(e) {
  return typeof e == "number" || e === null ? e : void 0;
}
function es(e, t) {
  return {
    text: ee(e[t]) ?? "",
    encoding: ee(e[`${t}Encoding`]) ?? "utf8",
    truncated: e[`${t}Truncated`] === !0,
    ...(ee(e[`${t}Base64`]) ? { base64: ee(e[`${t}Base64`]) } : {}),
  };
}
function Hv(e) {
  for (let t of ["jobs", "crons", "scopes", "providers", "resources", "items"]) {
    let n = e[t];
    if (Array.isArray(n)) return n;
  }
  return [];
}
function yn(e, t) {
  if (typeof e != "string" || e.trim().length === 0) throw new Error(`${t} is required`);
}
function Wv(e, t) {
  if (e === "cue_jobs") {
    let n = t;
    n.action !== "list" && yn(n.id, `cue_jobs ${n.action} id`);
  } else if (e === "cue_schedule") {
    let n = t;
    n.action === "add"
      ? (yn(n.schedule, "cue_schedule add schedule"), yn(n.command, "cue_schedule add command"))
      : n.action !== "list" && yn(n.id, `cue_schedule ${n.action} id`);
  } else if (e === "cue_scope") {
    let n = t;
    n.action === "env_set"
      ? (yn(n.key, "cue_scope env_set key"), yn(n.value, "cue_scope env_set value"))
      : n.action === "env_unset"
        ? yn(n.key, "cue_scope env_unset key")
        : (n.action === "path_prepend" || n.action === "cd") &&
          yn(n.path, `cue_scope ${n.action} path`);
  }
}
function hx(e, t, n, r, o, i = !1) {
  if (e === "cue_exec") {
    let m = t.background === !0;
    return {
      tool: e,
      text: n,
      ok: o,
      kind: m ? "background" : "foreground",
      ...(ee(r.jobId) ? { jobId: ee(r.jobId) } : {}),
      ...(ee(r.chainId) ? { chainId: ee(r.chainId) } : {}),
      ...(ee(r.status) ? { status: ee(r.status) } : {}),
      ...(Jt(r.exitCode) !== void 0 ? { exitCode: Jt(r.exitCode) } : {}),
      timedOut: r.timedOut === !0,
      detached: m || r.switchedToBackground === !0,
      cancelled: i,
      stdout: es(r, "stdout"),
      stderr: es(r, "stderr"),
      warnings: Array.isArray(r.warnings) ? r.warnings.filter((p) => typeof p == "string") : [],
    };
  }
  if (e === "cue_run" || e === "cue_script")
    return {
      tool: e,
      text: n,
      ok: o,
      ...(ee(r.scriptId) ? { scriptId: ee(r.scriptId) } : {}),
      ...(r.source !== void 0 ? { source: r.source } : {}),
      status: ee(r.status) ?? (i ? "cancelled" : o ? "finished" : "failed"),
      ...(Jt(r.exitCode) !== void 0 ? { exitCode: Jt(r.exitCode) } : {}),
      ...(Jt(r.failedItemIndex) !== void 0 ? { failedItemIndex: Jt(r.failedItemIndex) } : {}),
      timedOut: r.timedOut === !0,
      cancelled: i,
      items: Array.isArray(r.items) ? r.items : [],
    };
  if (e === "script_run" || e === "script_eval") {
    let m = t.language;
    return {
      tool: e,
      text: n,
      ok: o,
      language: m,
      kind: m === "python" ? "python-job" : "cue-shell-script",
      ...(ee(r.scriptId) ? { scriptId: ee(r.scriptId) } : {}),
      ...(ee(r.jobId) ? { jobId: ee(r.jobId) } : {}),
      status: ee(r.status) ?? (i ? "cancelled" : o ? "finished" : "failed"),
      ...(Jt(r.exitCode) !== void 0 ? { exitCode: Jt(r.exitCode) } : {}),
      timedOut: r.timedOut === !0,
      cancelled: i,
      items: Array.isArray(r.items) ? r.items : [],
      stdout: es(r, "stdout"),
      stderr: es(r, "stderr"),
    };
  }
  if (e === "cue_history")
    return {
      tool: e,
      text: n,
      ok: o,
      ...(t.id ? { targetId: t.id } : {}),
      rawChars: typeof r.rawChars == "number" ? r.rawChars : n.length,
      shownChars: typeof r.shownChars == "number" ? r.shownChars : n.length,
      lines: n ? n.split(/\r?\n/u).length : 0,
      truncated: r.truncated === !0,
    };
  let a = t.action,
    c = t.id;
  return {
    tool: e,
    text: n,
    ok: o,
    action: a,
    ...(ee(r.targetId) || ee(r.id) || c ? { targetId: ee(r.targetId) ?? ee(r.id) ?? c } : {}),
    ...(ee(r.status) ? { status: ee(r.status) } : {}),
    ...(typeof r.found == "boolean" ? { found: r.found } : {}),
    timedOut: r.timedOut === !0,
    ...(typeof r.count == "number" ? { count: r.count } : {}),
    ...(typeof r.shown == "number" ? { shown: r.shown } : {}),
    records: Hv(r),
    ...(ee(r.jobId) ? { jobId: ee(r.jobId) } : {}),
    ...(ee(r.chainId) ? { chainId: ee(r.chainId) } : {}),
    ...(ee(r.cronId) ? { cronId: ee(r.cronId) } : {}),
    ...(Jt(r.exitCode) !== void 0 ? { exitCode: Jt(r.exitCode) } : {}),
    ...(ee(r.key) ? { key: ee(r.key) } : {}),
    ...(ee(r.path) ? { path: ee(r.path) } : {}),
    ...(ee(r.cwd) ? { cwd: ee(r.cwd) } : {}),
    ...(r.scope !== void 0 ? { scope: r.scope } : {}),
    ...(typeof r.rawChars == "number" ? { rawChars: r.rawChars } : {}),
    ...(typeof r.shownChars == "number" ? { shownChars: r.shownChars } : {}),
    ...(typeof r.truncated == "boolean" ? { truncated: r.truncated } : {}),
  };
}
function xx(e = {}) {
  let t = new Map(),
    n = fx({
      registerTool(i) {
        Co.includes(i.name) && t.set(i.name, i);
      },
    }),
    r = new Map(),
    o = !1;
  return {
    async execute(i, a, c) {
      if (o) throw new Error("Cue tool runtime is disposed");
      let m = t.get(i);
      if (!m) throw new Error(`Unknown Cue tool: ${i}`);
      Wv(i, a);
      let p = c.signal ?? new AbortController().signal,
        d = {
          sessionId: c.sessionId,
          cwd: c.cwd,
          env: c.env,
          cueRemoteCwd: e.remoteCwd,
          cueAutoStartLocal: e.autoStartLocal ?? !0,
          cueForwardSensitiveEnv: e.forwardSensitiveEnv ?? !1,
          cueResolvedTransport: e.resolvedTransport,
          cueClient: e.client,
        };
      r.set(c.sessionId, d);
      try {
        let g = await m.execute(
          c.operationId ?? `${c.sessionId}:${i}`,
          a,
          p,
          (x) => c.onUpdate?.(gx(x.content)),
          d,
        );
        return hx(i, a, gx(g.content), g.details ?? {}, !0);
      } catch (g) {
        let x = g && typeof g == "object" && "details" in g ? (g.details ?? {}) : void 0,
          I = p.aborted || (g instanceof Error && g.name === "AbortError");
        if (!x && !I) throw g;
        let T = g instanceof Error ? g.message : String(g);
        return hx(i, a, T, x ?? {}, !1, I);
      }
    },
    releaseSession(i) {
      let a = r.get(i);
      a && (r.delete(i), n.releaseSession(a));
    },
    dispose() {
      o || ((o = !0), r.clear(), n.dispose());
    },
  };
}
var tQ = "dsh-tool-cue",
  nQ = ["tools", "systemPrompt", "sandboxPolicy", "shellEnv"],
  rQ = ts.object({
    autoStartLocal: ts.boolean().default(!0),
    remoteCwd: ts.string(),
    forwardSensitiveEnv: ts.boolean().default(!1),
  }),
  Xv =
    "cue-shell is direct-exec (execvp), not bash \u2014 do not use raw '|', ';', '<', '>', '$()' or backticks. Composition operators: '|>' pipes stdout in one job, '&&'/'||' are job-internal logic, '->' serial-on-success, '~>' serial ignoring failure, '|||' parallel, '|?|' any-success race. Example: 'cargo build |> grep error -> cargo test'. Rewrite bash-style pipes/redirection before calling.",
  ns = {
    type: "object",
    additionalProperties: !1,
    properties: {
      text: { type: "string", required: !0 },
      encoding: { type: "string", required: !0 },
      truncated: { type: "boolean", required: !0 },
      base64: { type: "string" },
    },
  };
function Eo(e) {
  return {
    tool: { type: "string", const: e, required: !0 },
    text: { type: "string", required: !0 },
    ok: { type: "boolean", required: !0 },
  };
}
var Yv = {
  type: "object",
  additionalProperties: !1,
  properties: {
    ...Eo("cue_exec"),
    kind: { type: "string", enum: ["foreground", "background"], required: !0 },
    jobId: { type: "string" },
    chainId: { type: "string" },
    status: { type: "string" },
    exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
    timedOut: { type: "boolean", required: !0 },
    detached: { type: "boolean", required: !0 },
    cancelled: { type: "boolean", required: !0 },
    stdout: { ...ns, required: !0 },
    stderr: { ...ns, required: !0 },
    warnings: { type: "array", items: { type: "string" }, required: !0 },
  },
};
function yx(e) {
  return {
    type: "object",
    additionalProperties: !1,
    properties: {
      ...Eo(e),
      scriptId: { type: "string" },
      source: { type: "json" },
      status: { type: "string", required: !0 },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      failedItemIndex: { oneOf: [{ type: "integer" }, { type: "null" }] },
      timedOut: { type: "boolean", required: !0 },
      cancelled: { type: "boolean", required: !0 },
      items: { type: "array", items: { type: "json" }, required: !0 },
    },
  };
}
function bx(e) {
  return {
    type: "object",
    additionalProperties: !1,
    properties: {
      ...Eo(e),
      language: { type: "string", enum: ["cue-shell", "python"], required: !0 },
      kind: { type: "string", enum: ["cue-shell-script", "python-job"], required: !0 },
      scriptId: { type: "string" },
      jobId: { type: "string" },
      status: { type: "string", required: !0 },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      timedOut: { type: "boolean", required: !0 },
      cancelled: { type: "boolean", required: !0 },
      items: { type: "array", items: { type: "json" }, required: !0 },
      stdout: { ...ns, required: !0 },
      stderr: { ...ns, required: !0 },
    },
  };
}
function Ae(e, t) {
  return {
    type: "object",
    additionalProperties: !1,
    properties: {
      ...Eo(e),
      action: { type: "string", const: t, required: !0 },
      targetId: { type: "string" },
      status: { type: "string" },
      found: { type: "boolean" },
      timedOut: { type: "boolean", required: !0 },
      count: { type: "integer" },
      shown: { type: "integer" },
      records: { type: "array", items: { type: "json" }, required: !0 },
      jobId: { type: "string" },
      chainId: { type: "string" },
      cronId: { type: "string" },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      key: { type: "string" },
      path: { type: "string" },
      cwd: { type: "string" },
      scope: { type: "json" },
      rawChars: { type: "integer" },
      shownChars: { type: "integer" },
      truncated: { type: "boolean" },
    },
  };
}
var Qv = {
    oneOf: [
      Ae("cue_jobs", "list"),
      Ae("cue_jobs", "status"),
      Ae("cue_jobs", "wait"),
      Ae("cue_jobs", "stop"),
    ],
  },
  Zv = { oneOf: [Ae("cue_resources", "providers"), Ae("cue_resources", "resources")] },
  eS = {
    oneOf: [
      Ae("cue_schedule", "add"),
      Ae("cue_schedule", "list"),
      Ae("cue_schedule", "pause"),
      Ae("cue_schedule", "resume"),
      Ae("cue_schedule", "remove"),
    ],
  },
  tS = {
    oneOf: [
      Ae("cue_scope", "list"),
      Ae("cue_scope", "env"),
      Ae("cue_scope", "config"),
      Ae("cue_scope", "env_set"),
      Ae("cue_scope", "env_unset"),
      Ae("cue_scope", "path_prepend"),
      Ae("cue_scope", "cd"),
      Ae("cue_scope", "refresh"),
      Ae("cue_scope", "status"),
    ],
  },
  nS = {
    type: "object",
    additionalProperties: !1,
    properties: {
      ...Eo("cue_history"),
      targetId: { type: "string" },
      rawChars: { type: "integer", required: !0 },
      shownChars: { type: "integer", required: !0 },
      lines: { type: "integer", required: !0 },
      truncated: { type: "boolean", required: !0 },
    },
  },
  rS = {
    cue_exec: {
      description:
        "Execute a direct command or Cue composition through cued; timeout detaches rather than killing the job. " +
        Xv,
      parameters: {
        command: { type: "string", required: !0 },
        background: { type: "boolean" },
        timeout: { type: "number" },
        cwd: { type: "string" },
        pty: { type: "boolean" },
        tail_bytes: { type: "number" },
        needs: { type: "object", additionalProperties: !0 },
      },
      output: Yv,
    },
    cue_run: {
      description: "Run a .cue file through cued with fail-fast script semantics.",
      parameters: {
        path: { type: "string", required: !0 },
        timeout: { type: "number" },
        tail_bytes: { type: "number" },
      },
      output: yx("cue_run"),
    },
    cue_script: {
      description: "Run an inline cue-shell script through cued.",
      parameters: {
        script: { type: "string", required: !0 },
        pathLabel: { type: "string" },
        timeout: { type: "number" },
        tail_bytes: { type: "number" },
      },
      output: yx("cue_script"),
    },
    script_run: {
      description: "Run a cue-shell or Python script file through cued.",
      parameters: {
        path: { type: "string", required: !0 },
        language: { type: "string", enum: ["cue-shell", "python"], required: !0 },
        timeout: { type: "number" },
        tail_bytes: { type: "number" },
        venv: { type: "string" },
      },
      output: bx("script_run"),
    },
    script_eval: {
      description: "Evaluate an inline cue-shell or Python script through cued.",
      parameters: {
        script: { type: "string", required: !0 },
        language: { type: "string", enum: ["cue-shell", "python"], required: !0 },
        pathLabel: { type: "string" },
        timeout: { type: "number" },
        tail_bytes: { type: "number" },
        venv: { type: "string" },
      },
      output: bx("script_eval"),
    },
    cue_jobs: {
      description: "List, inspect, wait for, or stop cued jobs and chains.",
      parameters: {
        action: { type: "string", enum: ["list", "status", "wait", "stop"], required: !0 },
        id: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
        timeout: { type: "number" },
        tail_bytes: { type: "number" },
      },
      output: Qv,
    },
    cue_resources: {
      description: "Inspect cued providers and resource availability.",
      parameters: { action: { type: "string", enum: ["providers", "resources"], required: !0 } },
      output: Zv,
    },
    cue_schedule: {
      description: "Add, list, pause, resume, or remove cued schedules.",
      parameters: {
        action: {
          type: "string",
          enum: ["add", "list", "pause", "resume", "remove"],
          required: !0,
        },
        id: { type: "string" },
        schedule: { type: "string" },
        command: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
      },
      output: eS,
    },
    cue_scope: {
      description: "Inspect or mutate the current cued scope.",
      parameters: {
        action: {
          type: "string",
          enum: [
            "list",
            "env",
            "config",
            "env_set",
            "env_unset",
            "path_prepend",
            "cd",
            "refresh",
            "status",
          ],
          required: !0,
        },
        key: { type: "string" },
        value: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
        includeEnv: { type: "boolean" },
        tail_bytes: { type: "number" },
      },
      output: tS,
    },
    cue_history: {
      description: "Read bounded cued command, job, chain, or script history.",
      parameters: {
        id: { type: "string" },
        limit: { type: "number" },
        tail_bytes: { type: "number" },
      },
      output: nS,
    },
  };
function oS(e) {
  return e.content.filter((t) => t.type === "text").map((t) => t.text).join(`
`);
}
function iS(e, t) {
  if (e === "cue_exec" && t.background !== !0 && typeof t.command == "string")
    return {
      card: "terminal",
      title: t.command,
      ...(typeof t.cwd == "string" ? { cwd: t.cwd } : {}),
    };
  let n = typeof t.action == "string" ? ` ${t.action}` : "";
  return {
    card: "generic",
    title: `${e}${n}`,
    kind: e === "cue_resources" || e === "cue_history" ? "read" : "execute",
    rawInput: t,
  };
}
function sS(e, t) {
  let n = oS(t);
  return e === "cue_exec"
    ? { card: "terminal", output: n }
    : { card: "generic", title: t.isError ? `${e} failed` : `${e} completed`, content: t.content };
}
function aS(e, t, n) {
  let r = rS[n];
  e.tools.register(
    Vv({
      name: n,
      description: r.description,
      parameters: r.parameters,
      output: { schema: r.output, render: (o, i) => [{ type: "text", text: i.text }] },
      presentCall: (o) => iS(n, o),
      presentResult: (o, i) => sS(n, i),
      async execute(o, i) {
        let a = i.agent;
        if (a === void 0) throw new Error(`${n} requires a DSH Agent and Session`);
        let c = a.session.header.cwd;
        if (c === void 0) throw new Error(`${n} requires an immutable session cwd`);
        let m = { ...process.env, ...e.shellEnv.collect(i) };
        return t.execute(n, o, {
          sessionId: `dsh:${a.session.id}`,
          cwd: c,
          env: m,
          signal: i.signal,
          operationId: String(i.callId),
        });
      },
    }),
  );
}
function uS(e, t) {
  for (let n of Co) aS(e, t, n);
}
function oQ(e, t = {}) {
  let n = xx({
    autoStartLocal: t.autoStartLocal ?? !0,
    remoteCwd: t.remoteCwd,
    forwardSensitiveEnv: t.forwardSensitiveEnv ?? !1,
  });
  (e.tools.guard((r) => {
    if (Co.includes(r.name))
      return r.agent === void 0 ? `${r.name} requires a DSH Agent and Session` : void 0;
  }),
    e.on("tools/pre-execute", (r, o) => {
      if (!Co.includes(r.name) || r.agent === void 0) return o();
      let i = e.sandboxPolicy.resolve({ session: r.agent.session });
      return i.mode !== "danger-full-access"
        ? Promise.resolve({
            kind: "deny",
            reason: `${r.name} requires danger-full-access because external cued execution is not confined by the DSH file sandbox (current mode: ${i.mode})`,
          })
        : o();
    }),
    e.systemPrompt.section({
      name: "tool:cue",
      order: 105,
      text: "Use Cue tools for command, script, job, resource, schedule, scope, and history operations. Cue is direct-exec rather than Bash; use Cue composition operators. If a command contains bash-style pipe/redirection/semicolon, rewrite it to Cue operators first \u2014 never retry raw bash syntax. A foreground timeout detaches the durable job instead of killing it.",
    }),
    uS(e, n),
    e.on("agent/disposed", ({ agent: r }) => n.releaseSession(`dsh:${r.session.id}`)),
    e.effect(() => () => n.dispose(), "dsh-tool-cue runtime teardown"));
}
export {
  rQ as Config,
  oQ as apply,
  nQ as inject,
  tQ as name,
  iS as presentCueCall,
  sS as presentCueResult,
  uS as registerCueToolDefinitions,
};
