pub struct User {
    pub name: String,
    pub nickname: Option<String>,
}

pub fn display_name(user: &User) -> &str {
    &user.name
}

pub fn greeting(user: &User) -> String {
    format!("Hello, {}", display_name(user))
}
