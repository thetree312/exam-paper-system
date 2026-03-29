from main import _build_celery_worker_command, settings


def test_build_celery_worker_command_subscribes_all_pipeline_queues() -> None:
    cmd = _build_celery_worker_command()

    assert "-Q" in cmd
    queue_arg = cmd[cmd.index("-Q") + 1]
    assert queue_arg == ",".join(
        [
            settings.celery_queue_preview,
            settings.celery_queue_glm_layout,
            settings.celery_queue_embed,
        ]
    )
