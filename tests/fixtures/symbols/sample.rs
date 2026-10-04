pub struct Foo {
    a: i32,
}

impl Foo {
    pub fn new() -> Self {
        Foo { a: 1 }
    }

    fn bar(&self) -> &str {
        "}"
    }
}

fn main() {
    let f = Foo::new();
    let _ = f.bar();
}
