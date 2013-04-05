<?php
$accessId = '';
$secretKey = '';

$query = implode("\n", array(
    $_POST['verb'],
    $_POST['md5'],
    $_POST['type'],
    '',
    $_POST['headers'],
    $_POST['resource'],
));
$signature = base64_encode(hash_hmac(
    'sha1',
    utf8_encode($query),
    $secretKey,
    true
));
$auth = 'AWS '.$accessId.':'.$signature;
echo json_encode(array(
    'auth'  => $auth,
    'query' => $query
));
?>