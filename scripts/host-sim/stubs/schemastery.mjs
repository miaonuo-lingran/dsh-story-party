// 桩：@deepseek-ai/schemastery —— 只需要能链式构造 Config，不参与校验
const schema = () => {
  const node = {
    default() { return node },
    required() { return node },
    min() { return node },
    max() { return node },
    volatile() { return node },
    description() { return node },
    example() { return node },
  }
  return node
}

const z = {
  object: schema,
  string: schema,
  number: schema,
  natural: schema,
  boolean: schema,
  array: schema,
  union: schema,
  dict: schema,
  any: schema,
}

export default z
