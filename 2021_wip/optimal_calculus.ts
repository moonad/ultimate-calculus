// About scope violations
// ----------------------
//
// The optimal calculus is, essentially, an optimized storage format for
// interaction net nodes of the sharing graphs used on optimal evaluators of the
// λ-calculus. The main optimization is that lambdas and application nodes store
// only two pointers, skipping the pointer to their own parents. This change
// requires us to 
//
// Scope violations are unavoidable when lazy copying lambdas. For example,
// consider the following reduction:
//
// let f = λx.(+ x 1); [(f 10) (f 20)] ~>
// let f = {x0 x1}; [(λx0.f 10) (λx1.f 20)] ~>
// [(λx0.x0 10) (λx1.x1 20)] ~>
// [10 20]
//
// Notice that, for a brief moment, the x0 and y0 variables bound by the two
// partially copied lambdas lived outside their scopes. That is unavoidable if
// we want optimal sharing (avoid duplicated computation) inside binders. This
// raises a problem when it comes to evaluation order, though. Consider the
// following reduction:
//
//   (t 1 (λt.0 λa.λb.a)) ~>
//   (λa.λb.a 1 0) ~>
//   1
//
// In this case, a recursive evaluator will pass through the `(t 1)`
// application, and apply `λt.0` to `λa.λb.a`, resulting in `0`, and replacing
// the earlier `t` by `λa.λb.a`. And that's the problem: the evaluator will not
// go back to `(λa.λb.a 1 0)`, so it will not reach normal form. We need to call
// normalize() again for that to happen. On interaction nets, that isn't the
// case, because the `λt.0` node has a pointer to the application node where its
// variable is used, so it can go back. This pointer doesn't exist in the
// optimal calculus.
//
// In practice, though, this situation shouldn't arise very often, and we can
// combine garbage-collection passes with normalization passes, until all terms
// are reduced.
// 
// About garbage collection
// ------------------------
// 
// Garbage collection is triggered when a value goes out of scope. For example:
//
// (λa.λb.b BIG b)
//
// This collects BIG, because it goes out of scope (since the lambda doesn't use
// the variable it would be bound to). The garbage collector will, though, stop
// at fan nodes, so, if the value is shared, it won't be collected. This can
// lead to memory leaks, though. For example, consider this term:
//
// λx.(λa.λb.b λt.(x x) λk.k)
//
// After one reduction, it becomes:
//
// λx.(λb.b λk.k)
//
// And the `λt.(x x)` sub-term will be freed, because `λa` is unbound. But now
// the `λx` lambda will be bound to a fan node with two erasure nodes, NOT an
// erasure node directly! So, if `λx` is applied to something, that thing won't
// be garbage collected, and we'll have a memory leak. Simpler visualization:
//
// ((λa. λb. let {x,y} = a; b) BIG λk.k)
// 
// Here, BIG will never be collected, because λa is not bound to an erasure
// node, but to a fan node that copies its argument, and then erases it, twice.
// In order to be garbage-free, we'd need to evaluate arguments eagerly, but
// then we'd waste a lot of computation and lose lazy evaluation. As such, we do
// let memory leaks occur in these cases, and supplement with a global garbage
// collector, but it is extremely efficient since most of the garbage is
// collected preemptively.
//
// Note also that the adoption of equational-notation rewrite nodes counter this
// problem very well. For example, consider the following function:
//
// let fn = λ(b:Bool). case b { true: "BIG_STRING", false: "cat" }
// fn(false)
//
// If we compiled that program to λ-encodings, we'd get the following:
//
// (λb.(b "BIG_STRING" "cat"))(λt.λf.f) ~>
// (λt.λf.f "BIG_STRING" "cat") ~>
// (λf.f "cat") ~>
// "cat"
//
// But, while doing so, "BIG_STRING" would be stuck on memory as garbage. This
// is a problem when we λ-encode everything: pattern-matching leaves a lot of
// garbage. But if we, instead, represented constructors as interaction net
// nodes, and expressed `fn` in the equational notation:
//
// fn true  = "BIG_STRING"
// fn false = "cat"
//
// Then we'd have the following, direct reduction:
//
// (fn false) ~>
// "cat"

// The Optimal Calculus
// ====================

type MAP<T> = Record<string, T>;

const NIL : number = 0
const LAM : number = 1
const APP : number = 2
const PAR : number = 3
const DP0 : number = 4 // ex0 = color
const DP1 : number = 5 // ex0 = color
const VAR : number = 6
const LNK : number = 7
const CTR : number = 8 // ex0 = arity, ex1 = variant
const CAL : number = 9 // ex0 = arity, ex1 = function

type Tag = number // 4 bits
type Ex0 = number // 8 bits
type Ex1 = number // 8 bits
type Pos = number // 32 bits

type Ptr = number

// Utils
// -----

function pad(str : string, len : number) {
  while (str.length < len) {
    str = " " + str;
  }
  return str.slice(-len);
}

// Memory
// ------

var RE0 : Array<Ptr> = [];
var RE1 : Array<Ptr> = [];
var RE2 : Array<Ptr> = [];
var RE3 : Array<Ptr> = [];
var MEM : Array<Ptr> = [];
var GAS : number = 0;
var LIM : number = Infinity;

var MUL_A = Math.pow(2, 4);
var MUL_B = Math.pow(2, 12);
var MUL_C = Math.pow(2, 20);

function ptr(tag: Tag, pos: number, ex0: Ex0 = 0, ex1: Ex1 = 0) : Ptr {
  return tag + (ex0 * MUL_A) + (ex1 * MUL_B) + (pos * MUL_C);
}

function get_tag(ptr: Ptr) : Tag {
  return ptr & 0xF;
}

function get_ex0(ptr: Ptr) : Ex0 {
  return Math.floor(ptr / MUL_A) & 0xFF;
}

function get_ex1(ptr: Ptr) : Ex1 {
  return Math.floor(ptr / MUL_B) & 0xFF;
}

function get_pos(ptr: Ptr) : number {
  return Math.floor(ptr / MUL_C);
}

function get_loc(ptr: Ptr, arg: number) : number {
  return Math.floor(ptr / MUL_C) + arg;
}

function get_arg(term: Ptr, idx: number) : Ptr {
  return MEM[get_loc(term,idx)];
}

function link(pos: number, term: Ptr) {
  MEM[pos] = term;
  switch (get_tag(term)) {
    case VAR: MEM[get_loc(term,0)] = ptr(LNK,pos); break;
    case DP0: MEM[get_loc(term,0)] = ptr(LNK,pos); break;
    case DP1: MEM[get_loc(term,1)] = ptr(LNK,pos); break;
  }
}

function alloc(size: number) : number {
  var reuse;
  switch (size) {
    case 0: reuse = RE0.pop(); break;
    case 1: reuse = RE1.pop(); break;
    case 2: reuse = RE2.pop(); break;
    case 3: reuse = RE3.pop(); break;
  }
  if (reuse !== undefined) {
    return reuse;
  } else {
    if (size > 0) {
      var pos = MEM.length;
      for (var k = 0; k < size; ++k) {
        MEM.push(0);
      }
      return pos;
    } else {
      return 0;
    }
  }
}

var IS_FREED : any = {};
function free(pos: number, size: number) {
  for (var k = pos; k < pos + size; ++k) {
    IS_FREED[k] = 1;
    MEM[k] = 0;
  }
  switch (size) {
    case 0: RE0.push(pos); break;
    case 1: RE1.push(pos); break;
    case 2: RE2.push(pos); break;
    case 3: RE3.push(pos); break;
  }
}

// Stringification
// ---------------

function show_tag(tag: Tag) {
  switch (tag) {
    case LAM: return "LAM";
    case APP: return "APP";
    case PAR: return "PAR";
    case DP0: return "DP0";
    case DP1: return "DP1";
    case VAR: return "VAR";
    case LNK: return "LNK";
    case NIL: return "NIL";
    case CTR: return "CTR";
    case CAL: return "CAL";
  }
}

function show_ptr(ptr: Ptr) {
  return show_tag(get_tag(ptr)) + ":" + get_pos(ptr) + (get_ex0(ptr) !== 0 ? "|" + get_ex0(ptr) : "");
}

function show_mem() {
  return MEM.map((x,i) => ("    "+i).slice(-3)+" "+show_ptr(x)).filter((x) => x.indexOf("NIL:0") === -1).join("\n");
}

function show_term(term: Ptr) : string {
  var lets : {[key:string]:number} = {};
  var names : {[key:string]:string} = {};
  var count = 0;
  function find_lets(term: Ptr) {
    switch (get_tag(term)) {
      case LAM:
        names[get_pos(term)] = String(++count);
        find_lets(get_arg(term,1));
        break;
      case APP:
        find_lets(get_arg(term,0));
        find_lets(get_arg(term,1));
        break;
      case PAR:
        find_lets(get_arg(term,0));
        find_lets(get_arg(term,1));
        break;
      case DP0:
        if (!lets[get_pos(term)]) {
          names[get_pos(term)] = String(++count);
          lets[get_pos(term)] = get_pos(term);
        }
        find_lets(get_arg(term,2));
        break;
      case DP1:
        if (!lets[get_pos(term)]) {
          names[get_pos(term)] = String(++count);
          lets[get_pos(term)] = get_pos(term);
        }
        find_lets(get_arg(term,2));
        break;
      case CTR:
      case CAL:
        var arity = get_ex0(term);
        for (var i = 0; i < arity; ++i) {
          find_lets(get_arg(term,i));
        }
        break;
    }
  }
  function go(term: Ptr) : string {
    switch (get_tag(term)) {
      case LAM: {
        var name = "x" + (names[get_pos(term)] || "?");
        return "λ" + name + ":" + go(get_arg(term,1));
      }
      case APP: {
        let func = go(get_arg(term,0));
        let argm = go(get_arg(term,1));
        return "(" + func + " " + argm + ")";
      }
      case PAR: {
        let kind = get_ex0(term);
        let func = go(get_arg(term,0));
        let argm = go(get_arg(term,1));
        return "&" + kind + "<" + func + " " + argm + ">";
      }
      case CTR: {
        let arit = get_ex0(term);
        let func = get_ex1(term);
        let args = [];
        for (let i = 0; i < arit; ++i) {
          args.push(go(get_arg(term,i)));
        }
        return "$" + func + ":" + arit + "{" + args.join(" ") + "}";
      }
      case CAL: {
        let arit = get_ex0(term);
        let func = get_ex1(term);
        let args = [];
        for (let i = 0; i < arit; ++i) {
          args.push(go(get_arg(term,i)));
        }
        return "$" + func + ":" + arit + "{" + args.join(" ") + "}";
      }
      case DP0: {
        return "a" + (names[get_pos(term)] || "?");
      }
      case DP1: {
        return "b" + (names[get_pos(term)] || "?");
      }
      case VAR: {
        return "x" + (names[get_pos(term)] || "?");
      }
    }
    return "?" + show_ptr(term);
  }
  find_lets(term);
  var text = "";
  for (var key in lets) {
    var pos = lets[key];
    var kind = get_ex0(term);
    var name = names[pos] || "?";
    text += "!" + kind + "<a"+name+" b"+name+"> = " + go(MEM[pos + 2]) + ";\n";
  }
  text += go(term);
  return text;
}

function show_lambda(term: Ptr) : string {
  var names : MAP<string> = {};
  var count = 0;
  var seen : MAP<boolean> = {};
  function name(term: Ptr, depth: number) {
    if (!seen[term]) {
      seen[term] = true;
      switch (get_tag(term)) {
        case LAM:
          if (get_tag(get_arg(term,0)) !== NIL) {
            names[ptr(VAR,get_pos(term))] = "x" + (++count);
          }
          name(get_arg(term,1), depth + 1);
          break;
        case APP:
          name(get_arg(term,0), depth + 1);
          name(get_arg(term,1), depth + 1);
          break;
        case PAR:
          name(get_arg(term,0), depth + 1);
          name(get_arg(term,1), depth + 1);
          break;
        case DP0:
          name(get_arg(term,2), depth + 1);
          break;
        case DP1:
          name(get_arg(term,2), depth + 1);
          break;
        case CTR:
          for (var i = 0; i < get_ex0(term); ++i) {
            name(get_arg(term,i), depth + 1);
          }
          break;
        case CAL:
          for (var i = 0; i < get_ex0(term); ++i) {
            name(get_arg(term,i), depth + 1);
          }
          break;
      }
    }
  }
  function go(term: Ptr, stacks: MAP<string>, seen: MAP<number>, depth: number) : string {
    if (seen[term]) {
      return "@";
      //return "(seen:" + Object.keys(seen).length + " | " + "depth:" + depth + ")";
    } else {
      //seen = {...seen, [term]: true};
      //if (depth > 30) return "(...)";
      switch (get_tag(term)) {
        case LAM: {
          let body = go(get_arg(term,1), stacks, seen, depth + 1);
          let name = "~";
          if (get_tag(get_arg(term,0)) !== NIL) {
            name = names[ptr(VAR,get_pos(term))] || "?";
          }
          return "λ" + name + ":" + body;
        }
        case APP: {
          let func = go(get_arg(term,0), stacks, seen, depth + 1);
          let argm = go(get_arg(term,1), stacks, seen, depth + 1);
          return "(" + func + " " + argm + ")"
        }
        case PAR: {
          let col = get_ex0(term);
          if (!stacks[col]) {
            stacks[col] = "";
          }
          if (stacks[col] !== undefined && stacks[col].length > 0) {
            if (stacks[col][0] === "0") {
              return go(get_arg(term,0), {...stacks,[col]:stacks[col].slice(1)}, seen, depth + 1);
            } else {
              return go(get_arg(term,1), {...stacks,[col]:stacks[col].slice(1)}, seen, depth + 1);
            }
          } else {
            let val0 = go(get_arg(term,0), stacks, seen, depth + 1);
            let val1 = go(get_arg(term,1), stacks, seen, depth + 1);
            return "{" + val0 + " " + val1 + "}"
          }
        }
        case DP0: {
          let col = get_ex0(term);
          return "" + go(get_arg(term,2), {...stacks,[col]:"0"+stacks[col]}, seen, depth + 1);
        }
        case DP1: {
          let col = get_ex0(term);
          return "" + go(get_arg(term,2), {...stacks,[col]:"1"+stacks[col]}, seen, depth + 1);
        }
        case CTR: {
          let func = get_ex1(term);
          let args = [];
          for (let i = 0; i < get_ex0(term); ++i) {
            args.push(go(get_arg(term,i), stacks, seen, depth + 1));
          }
          return "$" + String(func) + "{" + args.join(" ") + "}";
        }
        case CAL: {
          let func = get_ex1(term);
          let args = [];
          for (let i = 0; i < get_ex0(term); ++i) {
            args.push(go(get_arg(term,i), stacks, seen, depth + 1));
          }
          return "@" + String(func) + "{" + args.join(" ") + "}";
        }
        case VAR: {
          return names[term] || "^"+String(get_pos(term)) + "<" + show_ptr(MEM[get_pos(term)]) + ">";
        }
        case LNK: {
          return "!";
        }
        case NIL: {
          return "~";
        }
      }
      return "?(" + get_tag(term) + ")";
    }
  }
  name(term, 0);
  return go(term, {}, {}, 0);
}

// Parsing
// -------

function read(code: string): Ptr {
  //PARSING = true;
  var lams  : MAP<number> = {};
  var let0s : MAP<number> = {};
  var let1s : MAP<number> = {};
  var tag0s : MAP<number> = {};
  var tag1s : MAP<number> = {};
  var vars  : Array<[string,number]> = [];

  function build() {
    for (var [var_name, var_pos] of vars) {
      var lam = lams[var_name]
      if (lam !== undefined) {
        link(var_pos, ptr(VAR,lam));
      }
      var let0 = let0s[var_name]
      if (let0 !== undefined) {
        link(var_pos, ptr(DP0,let0,tag0s[var_name]||0));
      }
      var let1 = let1s[var_name]
      if (let1 !== undefined) {
        link(var_pos, ptr(DP1,let1,tag1s[var_name]||0));
      }
    }
  }

  function skip() {
    while (code[0] === " " || code[0] === "\n") {
      code = code.slice(1);
    }
  }

  function parse_name() : string {
    skip();
    var name = "";
    while ("a" <= code[0] && code[0] <= "z"
        || "A" <= code[0] && code[0] <= "Z"
        || "0" <= code[0] && code[0] <= "9"
        || "_" === code[0]
        || "." === code[0]) {
      name += code[0];
      code = code.slice(1);
    }
    return name;
  }

  function consume(str: string) {
    skip();
    if (code.slice(0, str.length) === str) {
      return code.slice(str.length);
    } else {
      throw "Bad parse: " + str;
    }
  }

  function parse_numb(): number {
    if (/[0-9]/.test(code[0])) {
      var num = "";
      while (/[0-9]/.test(code[0])) {
        num += code[0];
        code = code.slice(1);
      }
      return Number(num);
    } else {
      return Number(0);
    }
  }

  function parse_term(local: number) : Ptr {
    skip();
    var node = 0;
    switch (code[0]) {
      case "λ": 
        code = consume("λ");
        node = alloc(2);
        var name = parse_name();
        code = consume(":");
        var body = parse_term(node + 1);
        link(node+0, ptr(NIL,0));
        link(node+1, body);
        lams[name] = node;
        return ptr(LAM, node);
      case "(":
        code = consume("(");
        node = alloc(2);
        var func = parse_term(node + 0);
        var argm = parse_term(node + 1);
        code = consume(")");
        link(node+0, func);
        link(node+1, argm);
        return ptr(APP, node);
      case "&":
        code = consume("&");
        var col = parse_numb();
        code = consume("<");
        code = consume(">");
        node = alloc(2);
        var val0 = parse_term(node + 0);
        var val1 = parse_term(node + 1);
        link(node+0, val0);
        link(node+1, val1);
        skip();
        return ptr(PAR, node, col);
      case "!":
        code = consume("!");
        var col = parse_numb();
        code = consume("<");
        var nam0 = parse_name();
        var nam1 = parse_name();
        code = consume(">");
        code = consume("=");
        node = alloc(3);
        var expr = parse_term(node + 2);
        code = consume(";");
        var body = parse_term(local);
        link(node+0, ptr(NIL,0));
        link(node+1, ptr(NIL,0));
        link(node+2, expr);
        let0s[nam0] = node;
        tag0s[nam0] = col;
        let1s[nam1] = node;
        tag1s[nam1] = col;
        return body;
      // $0{1 2 3}
      case "$":
        code = consume("$");
        var func = parse_numb();
        code = consume(":");
        var arit = parse_numb();
        code = consume("{");
        var node = alloc(arit);
        var args = [];
        for (var i = 0; i < arit; ++i) {
          args.push(parse_term(node + i));
        }
        code = consume("}");
        for (var i = 0; i < arit; ++i) {
          link(node+i, args[i]);
        }
        return ptr(CTR, node, arit, func);
      // @0(1 2 3)
      case "@":
        code = consume("@");
        var func = parse_numb();
        code = consume(":");
        var arit = parse_numb();
        code = consume("{");
        var node = alloc(arit);
        var args = [];
        for (var i = 0; i < arit; ++i) {
          args.push(parse_term(node + i));
        }
        code = consume("}");
        for (var i = 0; i < arit; ++i) {
          link(node+i, args[i]);
        }
        return ptr(CAL, node, arit, func);
      default:
        var name = parse_name();
        var vari = ptr(NIL,0);
        vars.push([name, local]);
        return vari;
    }
  }
  MEM = [ptr(NIL,0)];
  link(0, parse_term(0));
  build();
  //PARSING = false;
  return MEM[0];
}

// Debug
// -----

function sanity_check() {
  for (var i = 0; i < MEM.length; ++i) {
    //if (MEM[i] !== 0 && MEM[get_pos(MEM[i])] === 0) {
      //throw new Error("Pointing to void at " + i + ".");
    //}
    switch (get_tag(MEM[i])) {
      case VAR:
        if (get_loc(MEM[get_loc(MEM[i],0)],0) !== i) {
          throw new Error("Bad var at " + i + ".");
        }
        break;
      case DP0:
        if (get_loc(MEM[get_loc(MEM[i],0)],0) !== i) {
          throw new Error("Bad dp0 at " + i + ".");
        }
        break;
      case DP1:
        if (get_loc(MEM[get_loc(MEM[i],1)],0) !== i) {
          throw new Error("Bad dp1 at " + i + ".");
        }
        break;
      case LAM:
        if (MEM[get_loc(MEM[i],1)] === 0) {
          throw new Error("Lambda pointing to nil body at " + i + ".");
        }
      //case PAR:
        //if (get_arg(MEM[i],0) === MEM[i] || get_arg(MEM[i],1) === MEM[i]) {
          //throw new Error("Self-referential pair at " + i + ".");
        //}
    }
  }
}

// Garbage Collection
// ------------------

// This function works fine. The problem is: when to call it? We could call it
// when a lambda with an unused variable is applied to an argument, i.e.,
// `((λx. a) b)` would erase `b` if `x` is not used (i.e., NIL). The problem is,
// not always `x` will be NIL if not used; it could be a fan node with two NILs
// instead, for example. So, doing that would not catch all situations where
// we'd want to call collect(). So I'd rather just not call it at all, and write
// a global garbage collector instead.
function collect(term: Ptr, host: null | number) {
  switch (get_tag(term)) {
    case LAM:
      if (get_tag(get_arg(term,0)) !== NIL) {
        link(get_loc(get_arg(term,0),0), ptr(NIL,0));
      }
      collect(get_arg(term,1), get_loc(term,1));
      free(get_loc(term,0), 2);
      break;
    case APP:
      collect(get_arg(term,0), get_loc(term,0));
      collect(get_arg(term,1), get_loc(term,1));
      free(get_loc(term,0), 2);
      break;
    case PAR:
      collect(get_arg(term,0), get_loc(term,0));
      collect(get_arg(term,1), get_loc(term,1));
      free(get_loc(term,0), 2);
      if (host) {
        link(host, ptr(NIL,0));
      }
      break;
    case DP0:
      link(get_loc(term,0), ptr(NIL,0));
      if (host) {
        free(host, 1);
      }
      break;
    case DP1:
      link(get_loc(term,1), ptr(NIL,0));
      if (host) {
        free(host, 1);
      }
      break;
    case CTR:
    case CAL:
      var arity = get_ex0(term);
      for (var i = 0; i < arity; ++i) {
        collect(get_arg(term,i), get_loc(term,i));
      }
      free(get_loc(term,0), arity);
      break;
    case VAR:
      link(get_loc(term,0), ptr(NIL,0));
      if (host) {
        free(host, 1);
      }
      break;
  }
}

// Reduction
// ---------

function subst(lnk: Ptr, val: Ptr) {
  if (get_tag(lnk) !== NIL) {
    link(get_loc(lnk,0), val);
  } else {
    // Attempting to GC here is futile. See note above.
    collect(val, null);
  }
}

var depth = 0;
function reduce(host: number) : Ptr {
  while (true) {
    var term = MEM[host];
    //console.log("REDUCE", depth, show_ptr(term));
    switch (get_tag(term)) {
      case APP:
        let func = reduce(get_loc(term,0));
        switch (get_tag(func)) {
          // (λx:b a)
          // --------- APP-LAM
          // x <- a
          case LAM: {
            if (GAS >= LIM) { return term; } else { ++GAS; }
            //console.log("[app-lam]", get_pos(term), get_pos(func));
            //sanity_check();
            subst(get_arg(func,0), get_arg(term,1));
            link(host, get_arg(func, 1));
            free(get_loc(term,0), 2);
            free(get_loc(func,0), 2);
            //console.log(show_term(MEM[0]));
            continue;
          }
          // (&A<a b> c)
          // ----------------- APP-PAR
          // !A<x0 x1> = c
          // &A<(a x0) (b x1)>
          case PAR: {
            if (GAS >= LIM) { return term; } else { ++GAS; }
            //console.log("[app-par]", get_pos(term), get_pos(func));
            //sanity_check();
            var let0 = alloc(3);
            var app0 = alloc(2);
            var app1 = alloc(2);
            var par0 = alloc(2);
            link(let0+2, get_arg(term, 1));
            link(app0+0, get_arg(func, 0));
            link(app0+1, ptr(DP0, let0, get_ex0(func)));
            link(app1+0, get_arg(func, 1));
            link(app1+1, ptr(DP1, let0, get_ex0(func)));
            link(par0+0, ptr(APP, app0));
            link(par0+1, ptr(APP, app1));
            link(host, ptr(PAR, par0, get_ex0(func)));
            free(get_loc(term,0), 2);
            free(get_loc(func,0), 2);
            //sanity_check();
            //console.log(show_term(MEM[0]));
            return MEM[host];
          }
        }
        break;
      case DP0:
      case DP1:
        let expr = reduce(get_loc(term,2));
        switch (get_tag(expr)) {
          // !A<r s> = λx: f
          // --------------- LET-LAM
          // r <- λx0: f0
          // s <- λx1: f1
          // x <- &A<x0 x1>
          // !A<f0 f1> = f
          // ~
          case LAM: {
            if (GAS >= LIM) { return term; } else { ++GAS; }
            //console.log("[let-lam]", get_pos(term), get_pos(expr));
            //sanity_check();
            var lam0 = alloc(2);
            var lam1 = alloc(2);
            var par0 = alloc(2);
            var let0 = alloc(3);
            link(lam0+1, ptr(DP0, let0, get_ex0(term)));
            link(lam1+1, ptr(DP1, let0, get_ex0(term)));
            link(par0+0, ptr(VAR, lam0));
            link(par0+1, ptr(VAR, lam1));
            link(let0+2, get_arg(expr, 1));
            subst(get_arg(term,0), ptr(LAM, lam0));
            subst(get_arg(term,1), ptr(LAM, lam1));
            subst(get_arg(expr,0), ptr(PAR, par0, get_ex0(term)));
            link(host, ptr(LAM, get_tag(term) === DP0 ? lam0 : lam1));
            free(get_loc(term,0), 3);
            free(get_loc(expr,0), 2);
            //sanity_check();
            //console.log(show_term(MEM[0]));
            continue;
          }
          // !A<x y> = !B<a b>
          // ----------------- LET-PAR
          // if A == B then
          //   x <- a
          //   y <- b
          //   ~
          // else
          //   x <- !B<xA xB>
          //   y <- !B<yA yB>
          //   !A<xA yA> = a
          //   !A<xB yB> = b
          //   ~
          case PAR: {
            if (GAS >= LIM) { return term; } else { ++GAS; }
            //console.log("[let-par]", get_pos(term), get_pos(expr));
            if (get_ex0(term) === get_ex0(expr)) {
              //sanity_check();
              subst(get_arg(term,0), get_arg(expr,0));
              subst(get_arg(term,1), get_arg(expr,1));
              link(host, get_arg(expr, get_tag(term) === DP0 ? 0 : 1));
              free(get_loc(term,0), 3);
              free(get_loc(expr,0), 2);
              //sanity_check();
              //console.log(show_term(MEM[0]));
              continue;
            } else {
              //sanity_check();
              var par0 = alloc(2);
              var par1 = alloc(2);
              var let0 = alloc(3);
              var let1 = alloc(3);
              link(par0+0, ptr(DP0,let0,get_ex0(term)));
              link(par0+1, ptr(DP0,let1,get_ex0(term)));
              link(par1+0, ptr(DP1,let0,get_ex0(term)));
              link(par1+1, ptr(DP1,let1,get_ex0(term)));
              link(let0+2, get_arg(expr,0));
              link(let1+2, get_arg(expr,1));
              subst(get_arg(term,0), ptr(PAR,par0,get_ex0(expr)));
              subst(get_arg(term,1), ptr(PAR,par1,get_ex0(expr)));
              link(host, ptr(PAR, get_tag(term) === DP0 ? par0 : par1, get_ex0(expr)));
              free(get_loc(term,0), 3);
              free(get_loc(expr,0), 2);
              //sanity_check();
              //console.log(show_term(MEM[0]));
              return MEM[host];
            }
          }
          // !A<x y> = $V:L{a b c ...}
          // -------------------------
          // !A<a0 a1> = a
          // !A<b0 b1> = b
          // !A<c0 c1> = c
          // ...
          // x <- $V:L{a0 b0 c0 ...}
          // y <- $V:L{a1 b1 c1 ...}
          // ~
          case CTR: {
            if (GAS >= LIM) { return term; } else { ++GAS; }
            //console.log("[let-ctr]", get_pos(term), get_pos(expr));
            let arit = get_ex0(expr);
            let func = get_ex1(expr);
            let ctr0 = alloc(arit);
            let ctr1 = alloc(arit);
            for (let i = 0; i < arit; ++i) {
              let leti = alloc(3);
              link(ctr0+i, ptr(DP0, leti));
              link(ctr1+i, ptr(DP1, leti));
              link(leti+2, get_arg(expr,i));
            }
            subst(get_arg(term,0), ptr(CTR, ctr0, arit, func));
            subst(get_arg(term,1), ptr(CTR, ctr1, arit, func));
            link(host, ptr(CTR, get_tag(term) === DP0 ? ctr0 : ctr1, arit, func));
            free(get_loc(term,0), 3);
            free(get_loc(expr,0), arit);
            //console.log(show_term(MEM[0]));
            return MEM[host];
          }
        }
        break;
    }
    return term;
  }
}

function normal(host: number) : Ptr {
  var seen : MAP<boolean> = {};
  function go(host: number) : Ptr {
    var term = MEM[host];
    //console.log("normal", show(term));
    if (seen[get_loc(term,0)]) {
      return term;
    } else {
      term = reduce(host);
      seen[get_loc(term,0)] = true;
      switch (get_tag(term)) {
        case LAM:
          link(get_loc(term,1), go(get_loc(term,1)));
          return term;
        case APP:
          link(get_loc(term,0), go(get_loc(term,0)));
          link(get_loc(term,1), go(get_loc(term,1)));
          return term;
        case PAR:
          link(get_loc(term,0), go(get_loc(term,0)));
          link(get_loc(term,1), go(get_loc(term,1)));
          return term;
        case DP0:
          link(get_loc(term,2), go(get_loc(term,2)));
          return term;
        case DP1:
          link(get_loc(term,2), go(get_loc(term,2)));
          return term;
        case CAL:
        case CTR:
          var arity = get_ex0(term);
          for (var i = 0; i < arity; ++i) {
            link(get_loc(term,i), go(get_loc(term,i)));
          }
          return term;
        default:
          return term;
      }
    }
  }
  return go(host);
}

// Tests
// -----

import {lambda_to_optimal} from "./lambda_to_optimal.ts"

var code : string = `
  let Y      = ((λr:λf:(f (r r f))) (λr:λf:(f (r r f))))

  let succ   = λn: λz: λs: (s n)
  let zero   = λz: λs: z
  let double = (Y λdouble: λn: (n zero λpred:(succ (succ (double pred)))))

  let true   = λt: λf: t
  let false  = λt: λf: f
  let nand   = λa: (a λb:(b false true) λb:(b true true))

  let slow   = (Y λslow: λn: (n true λpred:(nand (slow pred) (slow pred))))

  (slow
    (succ (succ (succ (succ
    (succ (succ (succ (succ
    (succ (succ (succ (succ
    (succ (succ (succ (succ
      zero
    ))))
    ))))
    ))))
    ))))
  )
`;

//var code : string = `
  //let a = $0{λx:x λx:x}
  //λt: (t a a)
//`;
  
var code : string = lambda_to_optimal(code);
//console.log(code);

var term = read(code);
//console.log(show_term(MEM[0]));

var norm = normal(0);
console.log("cost: " + String(GAS));
console.log("norm: " + show_lambda(MEM[0]));

//console.log("norm: " + show(MEM[0]));








