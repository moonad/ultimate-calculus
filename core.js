// Ultimate Calculus terms are defined by the following grammar:
//   term ::=
//   | {x} term               -- lambda
//   | (term term)            -- application
//   | [term,term]            -- pair
//   | let [x,y] = term; term -- projection
//   | x                      -- variable
const Lam = (name, body)             => ({tag: Lam, name, body});
const App = (func, argm)             => ({tag: App, func, argm});
const Par = (val0, val1)             => ({tag: Par, val0, val1});
const Let = (nam0, nam1, expr, body) => ({tag: Let, nam0, nam1, expr, body});
const Var = (name)                   => ({tag: Var, name});

// Its reduction rules are defined as:
//
// (({x}f) a)
// ---------- (app-lam)
// f [x <- a]
//
// let [x,y] = [a,b]; t
// -------------------- (let-par)
// t [x <- a][y <- b]
//
// let [x,y] = {x} f; t
// --------------------------------------------------------- (let-lam)
// let [x0,x1] = f; t [p <- {x0}p][q <- {x1}q][x <- [x0,x1]]
//
// ([a,b] c)
// -------------------------------- (app-par)
// let [x0,x1] = c; [(a x0),(b x1)]
//
// Here, [x <- a] stands for global name-capture-avoiding substitution.
function reduce(term, env, weak = false) {
  const weak_reduce = (term, env, weak) => (
    weak ? term : reduce(term, env, weak)
  );
  switch (term.tag) {
    case Lam: {
      const body = weak_reduce(term.body, env, weak);
      return Lam(term.name, body);
    }
    case App: {
      const func = reduce(term.func, env, true);
      // App-Lam
      if (func.tag === Lam) {
        env._rwts++;
        env[func.name] = () => term.argm;
        return reduce(func.body, env, weak);
      // App-Par
      } else if (func.tag === Par) {
        env._rwts++;
        const x0 = fresh(env);
        const x1 = fresh(env);
        const a0 = App(func.val0, Var(x0));
        const a1 = App(func.val1, Var(x1));
        return reduce(Let(x0, x1, term.argm, Par(a0, a1)), env, weak);
      } else {
        const func = weak_reduce(term.func, env, weak);
        const argm = weak_reduce(term.argm, env, weak);
        return App(func, argm);
      }
    }
    case Par: {
      const val0 = weak_reduce(term.val0, env, weak);
      const val1 = weak_reduce(term.val1, env, weak);
      return Par(val0, val1);
    }
    case Let: {
      const expr = reduce(term.expr, env, true);
      // Let-Lam
      if (expr.tag === Lam) {
        env._rwts++;
        const n0 = fresh(env);
        const n1 = fresh(env);
        const x0 = fresh(env);
        const x1 = fresh(env);
        env[term.nam0] = () => Lam(x0, Var(n0));
        env[term.nam1] = () => Lam(x1, Var(n1));
        env[expr.name] = () => Par(Var(x0), Var(x1));
        return reduce(Let(n0, n1, expr.body, term.body), env, weak);
      // Let-Par
      } else if (expr.tag === Par) {
        env._rwts++;
        env[term.nam0] = () => expr.val0;
        env[term.nam1] = () => expr.val1;
        return reduce(term.body, env, weak);
      } else {
        const expr = weak_reduce(term.expr, env, weak);
        const body = weak_reduce(term.body, env, weak);
        return Let(term.nam0, term.nam1, expr, body);
      }
    }
    case Var: {
      if (env[term.name]) {
        const value = env[term.name]();
        env[term.name] = () => {
          env._cpys++;
          return copy(value, env);
        }
        return reduce(value, env, weak);
      } else {
        return term;
      }
    }
  }
};

// Creates a fresh name
function fresh(env) {
  return `x${(env._size = (env._size || 0) + 1)}`;
}

// Makes a deep copy of a term, renaming its bound variables to fresh ones
function copy(term, env) {
  const name = {};
  function build_name(term) {
    switch (term.tag) {
      case Lam: {
        name[term.name] = fresh(env);
        build_name(term.body)
        break;
      }
      case App: {
        build_name(term.func);
        build_name(term.argm);
        break;
      }
      case Par: {
        build_name(term.val0);
        build_name(term.val1);
        break;
      }
      case Let: {
        name[term.nam0] = fresh(env);
        name[term.nam1] = fresh(env);
        build_name(term.expr);
        build_name(term.body);
        break;
      }
      case Var:
        break;
    }
  }
  function rename(term) {
    switch (term.tag) {
      case Lam: {
        const body = rename(term.body);
        return Lam(name[term.name], body);
      }
      case App: {
        const func = rename(term.func);
        const argm = rename(term.argm);
        return App(func, argm);
      }
      case Par: {
        const val0 = rename(term.val0);
        const val1 = rename(term.val1);
        return Par(val0, val1);
      }
      case Let: {
        const expr = rename(term.expr);
        const body = rename(term.body);
        return Let(name[term.nam0], name[term.nam1], expr, body);
      }
      case Var: {
        return Var(name[term.name] || term.name);
      }
    }
  }
  build_name(term);
  return rename(term);
};

module.exports = {Lam, App, Par, Let, Var, reduce, fresh, copy};
