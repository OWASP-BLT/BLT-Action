function isHumanCommenter(comment) {
    return (
        comment &&
        comment.user &&
        (comment.user.type === 'User' || comment.user.type === 'Mannequin')
    );
}

function extractUserInfo(comment) {
    const login = comment?.user?.login ?? "unknown";
    const type = comment?.user?.type ?? "unknown";
    return { login, type };
}

module.exports = { isHumanCommenter, extractUserInfo };