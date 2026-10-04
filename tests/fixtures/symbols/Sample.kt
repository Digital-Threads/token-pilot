package demo

class Greeter(private val name: String) {
    fun greet(x: Boolean, n: Int): String {
        return "${if (x) "}" else n}"
    }

    fun raw(): String {
        return """
            ${listOf("}").joinToString()} {
        """.trim()
    }

    fun last(): Int {
        return 1
    }
}

fun helper(): Int {
    return 2
}
