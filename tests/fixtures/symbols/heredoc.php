<?php
class Mailer {
    public function body($name) {
        return <<<EOT
Hello {$name}, don't reply {
EOT;
    }

    public function raw() {
        $s = <<<'NOW'
        It's {raw}, isn't it {
        NOW;
        return $s;
    }

    public function quoted() {
        return [<<<"HTML"
          <p>Don't {
          HTML, 2];
    }

    public function last() {
        return 4;
    }
}

function helper() {
    return 5;
}
