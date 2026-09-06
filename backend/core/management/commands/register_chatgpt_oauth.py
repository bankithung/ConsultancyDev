from urllib.parse import urlsplit

from django.core.management.base import BaseCommand, CommandError
from oauth2_provider.models import Application


class Command(BaseCommand):
    help = 'Register the exact HTTPS callback for the ChatGPT MCP connector.'

    def add_arguments(self, parser):
        parser.add_argument('--callback', required=True)

    def handle(self, *args, **options):
        callback = options['callback']
        parsed = urlsplit(callback)
        if (parsed.scheme != 'https' or parsed.netloc != 'chatgpt.com'
                or not parsed.path.startswith('/connector/oauth/')
                or parsed.query or parsed.fragment):
            raise CommandError('Expected an exact https://chatgpt.com/connector/oauth/... callback.')
        app, created = Application.objects.get_or_create(
            client_id='consultancy-chatgpt',
            defaults={'name': 'ChatGPT', 'client_type': Application.CLIENT_PUBLIC,
                      'authorization_grant_type': Application.GRANT_AUTHORIZATION_CODE,
                      'redirect_uris': callback, 'client_secret': '', 'skip_authorization': False},
        )
        if not created and (app.redirect_uris != callback or app.client_type != Application.CLIENT_PUBLIC
                            or app.authorization_grant_type != Application.GRANT_AUTHORIZATION_CODE
                            or app.skip_authorization):
            raise CommandError('Existing client settings differ. Review before changing the registration.')
        self.stdout.write(self.style.SUCCESS(f'Registered client {app.client_id}; callback: {callback}'))
